namespace PoMiniGames.Features.PoSurvive.Infrastructure.Persistence;

using System.Text.Json;
using Azure.Data.Tables;
using Microsoft.Extensions.Configuration;
using PoMiniGames.Infrastructure.Storage;
using PoMiniGames.Application.Simulation;
using PoMiniGames.Domain.Entities.Simulation;
using PoShared.Simulation.Models;

// GoF: Repository — abstracts Azure Table Storage persistence behind ISessionRepository
public sealed class SessionRepository : ISessionRepository
{
    private readonly TableServiceClient _tableService;

    private const string SessionsTable   = "SimulationSessions";
    private const string HeartbeatsTable = "HeartbeatEvents";

    public SessionRepository(IConfiguration configuration)
    {
        // Prefer Azurite in dev, Key Vault–provided connection string in production
        var connectionString =
            configuration.GetConnectionString("AzuriteTableStorage")
            ?? configuration["PoSurvive-TableStorageConnectionString"]
            ?? throw new InvalidOperationException(
                "No Azure Table Storage connection string found. " +
                "Set ConnectionStrings:AzuriteTableStorage (dev) or " +
                "PoSurvive-TableStorageConnectionString (Key Vault) in configuration.");

        _tableService = new TableServiceClient(connectionString);
    }

    // ─── ISessionRepository ──────────────────────────────────────────────────

    public async Task SaveSessionAsync(SimulationSession session, CancellationToken ct = default)
    {
        var tableClient = _tableService.GetTableClient(SessionsTable);
        await tableClient.CreateIfNotExistsAsync(ct);

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
                var storedTurns  = e.GetInt32("TotalTurns") ?? 0;
                var storedFood   = e.GetInt32("TotalFoodConsumed") ?? 0;
                var storedDamage = e.GetInt32("TotalDamageDealt") ?? 0;

                var newTurns  = Math.Max(storedTurns, session.TotalTurns);
                var newFood   = Math.Max(storedFood, session.TotalFoodConsumed);
                var newDamage = Math.Max(storedDamage, session.TotalDamageDealt);

                e["Outcome"]             = session.Outcome.ToString();
                e["WinningTeam"]         = session.WinningTeam?.ToString();
                e["TotalTurns"]          = newTurns;
                e["TotalFoodConsumed"]   = newFood;
                e["TotalDamageDealt"]    = newDamage;
                e["StartedAt"]           = session.StartedAt.ToString("O");
                e["EndedAt"]             = session.EndedAt?.ToString("O");
                e["TeamSize"]            = session.Config.TeamSize;
                e["AgentSnapshotsJson"]  = JsonSerializer.Serialize(session.AgentSnapshots);
                e["ConfigJson"]          = JsonSerializer.Serialize(session.Config);
                return true;
            },
            ct);
    }

    public async Task SaveHeartbeatBatchAsync(
        IEnumerable<HeartbeatEventDto> events,
        CancellationToken ct = default)
    {
        var tableClient = _tableService.GetTableClient(HeartbeatsTable);
        await tableClient.CreateIfNotExistsAsync(ct);

        foreach (var ev in events)
        {
            // RowKey: "{turnNumber:D6}-{agentId}"  e.g. "000042-R1"
            var rowKey = $"{ev.TurnNumber:D6}-{ev.AgentId}";
            var partition = ev.SessionId.ToString();
            // Heartbeats are append-only per (turn, agent) tuple — switch to AddEntity
            // and tolerate a 409 as the idempotent-retry path so a network blip can't
            // duplicate a heartbeat row.
            var entity = new TableEntity(partition, rowKey)
            {
                ["AgentId"]      = ev.AgentId,
                ["Team"]         = ev.Team,
                ["TurnNumber"]   = ev.TurnNumber,
                ["ThoughtText"]  = ev.ThoughtText,
                ["ActionTaken"]  = ev.ActionTaken,
                ["HpBefore"]     = ev.HpBefore,
                ["HpAfter"]      = ev.HpAfter,
                ["HungerBefore"] = ev.HungerBefore,
                ["HungerAfter"]  = ev.HungerAfter,
                ["GridSnapshot"] = ev.GridSnapshot,
            };

            try
            {
                await tableClient.AddEntityAsync(entity, ct);
            }
            catch (Azure.RequestFailedException ex) when (ex.Status == 409)
            {
                // Already persisted; treat as success.
            }
        }
    }
}
