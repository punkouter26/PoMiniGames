namespace PoSurvive.Infrastructure.Persistence.TableStorage;

using System.Text.Json;
using Azure.Data.Tables;
using Microsoft.Extensions.Configuration;
using PoSurvive.Application.Interfaces;
using PoSurvive.Domain.Entities;
using PoSurvive.Shared.Models;

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

        var entity = new TableEntity("session", session.SessionId.ToString())
        {
            ["Outcome"]             = session.Outcome.ToString(),
            ["WinningTeam"]         = session.WinningTeam?.ToString(),
            ["TotalTurns"]          = session.TotalTurns,
            ["TotalFoodConsumed"]   = session.TotalFoodConsumed,
            ["TotalDamageDealt"]    = session.TotalDamageDealt,
            ["StartedAt"]           = session.StartedAt.ToString("O"),
            ["EndedAt"]             = session.EndedAt?.ToString("O"),
            ["TeamSize"]            = session.Config.TeamSize,
            ["AgentSnapshotsJson"]  = JsonSerializer.Serialize(session.AgentSnapshots),
            ["ConfigJson"]          = JsonSerializer.Serialize(session.Config),
        };

        await tableClient.UpsertEntityAsync(entity, TableUpdateMode.Replace, ct);
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
            var entity = new TableEntity(ev.SessionId.ToString(), rowKey)
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

            await tableClient.UpsertEntityAsync(entity, TableUpdateMode.Replace, ct);
        }
    }
}
