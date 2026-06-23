namespace PoSurvive.Infrastructure.Persistence.TableStorage;

using Azure;
using Azure.Data.Tables;
using Microsoft.Extensions.Configuration;
using PoSurvive.Application.Interfaces;
using PoSurvive.Domain.Entities;

/// <summary>
/// Azure Table Storage implementation of IEvolutionRepository.
/// Persists DNA evolution records to the "EvolutionRecords" table.
/// </summary>
public sealed class EvolutionRepository : IEvolutionRepository
{
    private readonly TableServiceClient _tableService;
    private const string TableName = "EvolutionRecords";

    public EvolutionRepository(IConfiguration configuration)
    {
        var connectionString =
            configuration.GetConnectionString("AzuriteTableStorage")
            ?? configuration["PoSurvive-TableStorageConnectionString"]
            ?? throw new InvalidOperationException(
                "No Azure Table Storage connection string found. " +
                "Set ConnectionStrings:AzuriteTableStorage (dev) or " +
                "PoSurvive-TableStorageConnectionString (Key Vault) in configuration.");

        _tableService = new TableServiceClient(connectionString);
    }

    // ─── IEvolutionRepository ────────────────────────────────────────────────

    public async Task UpsertAsync(EvolutionRecord record, CancellationToken ct = default)
    {
        var tableClient = _tableService.GetTableClient(TableName);
        await tableClient.CreateIfNotExistsAsync(ct);

        var entity = new TableEntity(record.PartitionKey, record.DnaId)
        {
            ["DnaId"]            = record.DnaId,
            ["Predatory"]        = record.Predatory,
            ["Scavenger"]        = record.Scavenger,
            ["Paranoid"]         = record.Paranoid,
            ["Altruistic"]       = record.Altruistic,
            ["Methodical"]       = record.Methodical,
            ["Generation"]       = record.Generation,
            ["SourceSessionId"]  = record.SourceSessionId ?? "",
            ["ParentDnaIdsJson"] = record.ParentDnaIdsJson,
            ["Archetype"]        = record.Archetype ?? "",
            ["DominantTrait"]    = record.DominantTrait,
            ["CreatedAt"]        = record.CreatedAt.ToString("O"),
            ["WinCount"]         = record.WinCount,
            ["TotalSessions"]    = record.TotalSessions,
            ["TotalKills"]       = record.TotalKills,
            ["TotalFoodConsumed"] = record.TotalFoodConsumed,
            ["TotalDamageDealt"] = record.TotalDamageDealt,
        };

        await tableClient.UpsertEntityAsync(entity, TableUpdateMode.Replace, ct);
    }

    public async Task<EvolutionRecord?> GetAsync(string dnaId, CancellationToken ct = default)
    {
        var tableClient = _tableService.GetTableClient(TableName);
        await tableClient.CreateIfNotExistsAsync(ct);

        try
        {
            var response = await tableClient.GetEntityAsync<TableEntity>(
                "evolution", dnaId, cancellationToken: ct);
            return MapFromEntity(response.Value);
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return null;
        }
    }

    public async Task<IReadOnlyList<EvolutionRecord>> GetAllAsync(CancellationToken ct = default)
    {
        var tableClient = _tableService.GetTableClient(TableName);
        await tableClient.CreateIfNotExistsAsync(ct);

        var results = new List<EvolutionRecord>();
        var pages = tableClient.QueryAsync<TableEntity>(
            filter: "PartitionKey eq 'evolution'",
            cancellationToken: ct);

        await foreach (var page in pages)
        {
            results.Add(MapFromEntity(page));
        }

        return results
            .OrderByDescending(r => r.Generation)
            .ThenByDescending(r => r.WinCount)
            .ToList();
    }

    public async Task<IReadOnlyList<EvolutionRecord>> GetByGenerationAsync(
        int generation, CancellationToken ct = default)
    {
        var tableClient = _tableService.GetTableClient(TableName);
        await tableClient.CreateIfNotExistsAsync(ct);

        var results = new List<EvolutionRecord>();
        var pages = tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq 'evolution' and Generation eq {generation}",
            cancellationToken: ct);

        await foreach (var page in pages)
        {
            results.Add(MapFromEntity(page));
        }

        return results;
    }

    public async Task DeleteAllAsync(CancellationToken ct = default)
    {
        var tableClient = _tableService.GetTableClient(TableName);
        var all = await GetAllAsync(ct);

        foreach (var record in all)
        {
            await tableClient.DeleteEntityAsync("evolution", record.DnaId, cancellationToken: ct);
        }
    }

    // ─── Private helpers ────────────────────────────────────────────────────

    private static EvolutionRecord MapFromEntity(TableEntity entity)
    {
        return new EvolutionRecord
        {
            PartitionKey     = entity.PartitionKey,
            RowKey           = entity.RowKey,
            DnaId            = GetString(entity, "DnaId"),
            Predatory        = GetDouble(entity, "Predatory"),
            Scavenger        = GetDouble(entity, "Scavenger"),
            Paranoid         = GetDouble(entity, "Paranoid"),
            Altruistic       = GetDouble(entity, "Altruistic"),
            Methodical       = GetDouble(entity, "Methodical"),
            Generation       = GetInt(entity, "Generation"),
            SourceSessionId  = GetString(entity, "SourceSessionId"),
            ParentDnaIdsJson = GetString(entity, "ParentDnaIdsJson"),
            Archetype        = GetString(entity, "Archetype"),
            DominantTrait    = GetString(entity, "DominantTrait"),
            CreatedAt        = DateTimeOffset.TryParse(GetString(entity, "CreatedAt"), out var dt) ? dt : default,
            WinCount         = GetInt(entity, "WinCount"),
            TotalSessions    = GetInt(entity, "TotalSessions"),
            TotalKills       = GetInt(entity, "TotalKills"),
            TotalFoodConsumed = GetInt(entity, "TotalFoodConsumed"),
            TotalDamageDealt = GetInt(entity, "TotalDamageDealt"),
        };
    }

    private static string GetString(TableEntity e, string key)
        => e.TryGetValue(key, out var v) && v is string s ? s : "";

    private static int GetInt(TableEntity e, string key)
        => e.TryGetValue(key, out var v) && v is int i ? i : 0;

    private static float GetDouble(TableEntity e, string key)
        => e.TryGetValue(key, out var v) && v is double d ? (float)d : 0f;
}