namespace PoMiniGames.Features.PoSurvive.Infrastructure.Persistence;

using System.Text.Json;
using Azure.Data.Tables;
using PoMiniGames.Infrastructure.Storage;
using PoMiniGames.Application.Simulation;
using PoMiniGames.Domain.Entities.Simulation;
using PoShared.Simulation.Models;

// GoF: Repository — abstracts Azure Table Storage persistence behind ISessionRepository.
// Injects the shared DI TableServiceClient (StorageExtensions) so dev/prod/Managed-Identity
// resolution stays in one place; tables are ensured once per instance, not per call
// (startup also ensures them via StorageInitializer.AdditionalTables).
public sealed class SessionRepository(TableServiceClient tableServiceClient) : ISessionRepository
{
    private const string SessionsTable = "SimulationSessions";
    private const string HeartbeatsTable = "HeartbeatEvents";

    private readonly TableClient _sessions = tableServiceClient.GetTableClient(SessionsTable);
    private readonly TableClient _heartbeats = tableServiceClient.GetTableClient(HeartbeatsTable);
    private bool _sessionsEnsured;
    private bool _heartbeatsEnsured;

    // ─── ISessionRepository ──────────────────────────────────────────────────

    public async Task SaveSessionAsync(SimulationSession session, CancellationToken ct = default)
    {
        var tableClient = _sessions;
        if (!_sessionsEnsured)
        {
            await tableClient.CreateIfNotExistsAsync(ct);
            _sessionsEnsured = true;
        }

        // §1: optimistic-concurrency save. Sessions accumulate counters during a run
        // (TotalFoodConsumed, TotalDamageDealt, TotalTurns) so two progress saves cannot
        // overwrite each other when the orchestrator emits them in parallel.
        var partition = "session";
        var rowKey = session.SessionId.ToString();
        await TableConcurrency.UpdateWithRetryAsync<TableEntity>(
            tableClient,
            partitionKey: partition,
            rowKey: rowKey,
            factory: () => new TableEntity(partition, rowKey),
            mutate: e =>
            {
                // §2: the counters are monotonic across a run, so merge with max against the
                // stored row rather than blindly overwriting with the in-memory value. This
                // makes a stale/out-of-order progress save unable to regress another save's
                // accumulated totals (the previous code ignored `e` entirely — a blind replace
                // under an ETag that defeated the very concurrency it claimed to provide).
                var storedTurns = e.GetInt32("TotalTurns") ?? 0;
                var storedFood = e.GetInt32("TotalFoodConsumed") ?? 0;
                var storedDamage = e.GetInt32("TotalDamageDealt") ?? 0;

                var newTurns = Math.Max(storedTurns, session.TotalTurns);
                var newFood = Math.Max(storedFood, session.TotalFoodConsumed);
                var newDamage = Math.Max(storedDamage, session.TotalDamageDealt);

                e["Outcome"] = session.Outcome.ToString();
                e["WinningTeam"] = session.WinningTeam?.ToString();
                e["TotalTurns"] = newTurns;
                e["TotalFoodConsumed"] = newFood;
                e["TotalDamageDealt"] = newDamage;
                e["StartedAt"] = session.StartedAt.ToString("O");
                e["EndedAt"] = session.EndedAt?.ToString("O");
                e["TeamSize"] = session.Config.TeamSize;
                e["AgentSnapshotsJson"] = JsonSerializer.Serialize(session.AgentSnapshots);
                e["ConfigJson"] = JsonSerializer.Serialize(session.Config);
                return true;
            },
            ct);
    }

    public async Task SaveHeartbeatBatchAsync(
        IEnumerable<HeartbeatEventDto> events,
        CancellationToken ct = default)
    {
        var tableClient = _heartbeats;
        if (!_heartbeatsEnsured)
        {
            await tableClient.CreateIfNotExistsAsync(ct);
            _heartbeatsEnsured = true;
        }

        // Heartbeats are append-only per (turn, agent) tuple. All rows for one session share
        // a partition, so submit them as entity-group transactions (max 100 actions each)
        // instead of one round-trip per event. A 409 anywhere in a batch means a retried
        // flush re-sent rows that already landed — fall back to per-entity Add for that
        // batch, tolerating 409 as the idempotent-retry path.
        foreach (var sessionGroup in events.GroupBy(ev => ev.SessionId.ToString()))
        {
            var entities = sessionGroup.Select(ev =>
                // RowKey: "{turnNumber:D6}-{agentId}"  e.g. "000042-R1"
                new TableEntity(sessionGroup.Key, $"{ev.TurnNumber:D6}-{ev.AgentId}")
                {
                    ["AgentId"] = ev.AgentId,
                    ["Team"] = ev.Team,
                    ["TurnNumber"] = ev.TurnNumber,
                    ["ThoughtText"] = ev.ThoughtText,
                    ["ActionTaken"] = ev.ActionTaken,
                    ["HpBefore"] = ev.HpBefore,
                    ["HpAfter"] = ev.HpAfter,
                    ["HungerBefore"] = ev.HungerBefore,
                    ["HungerAfter"] = ev.HungerAfter,
                    ["GridSnapshot"] = ev.GridSnapshot,
                }).ToList();

            foreach (var chunk in entities.Chunk(100))
            {
                var batch = chunk
                    .Select(e => new TableTransactionAction(TableTransactionActionType.Add, e))
                    .ToList();
                try
                {
                    await tableClient.SubmitTransactionAsync(batch, ct);
                }
                catch (TableTransactionFailedException ex) when (ex.Status == 409)
                {
                    foreach (var entity in chunk)
                    {
                        try
                        {
                            await tableClient.AddEntityAsync(entity, ct);
                        }
                        catch (Azure.RequestFailedException dup) when (dup.Status == 409)
                        {
                            // Already persisted; treat as success.
                        }
                    }
                }
            }
        }
    }
}
