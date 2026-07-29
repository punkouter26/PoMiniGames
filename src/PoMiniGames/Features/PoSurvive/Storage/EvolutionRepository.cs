namespace PoMiniGames.Features.PoSurvive.Infrastructure.Persistence;

using Azure;
using Azure.Data.Tables;
using PoMiniGames.Application.Simulation;
using PoMiniGames.Domain.Entities.Simulation;
using PoMiniGames.Infrastructure.Storage;

/// <summary>
/// Azure Table Storage implementation of IEvolutionRepository.
/// Persists DNA evolution records to the "EvolutionRecords" table.
/// Injects the shared DI <see cref="TableServiceClient"/> (StorageExtensions) so
/// dev/prod/Managed-Identity resolution stays in one place; the table is ensured
/// once per instance, not per call (startup also ensures it via
/// StorageInitializer.AdditionalTables).
/// </summary>
public sealed class EvolutionRepository(TableServiceClient tableServiceClient) : IEvolutionRepository
{
    private const string TableName = "EvolutionRecords";
    private readonly TableClient _table = tableServiceClient.GetTableClient(TableName);
    private bool _ensured;

    private async Task<TableClient> EnsuredTableAsync(CancellationToken ct)
    {
        if (!_ensured)
        {
            await _table.CreateIfNotExistsAsync(ct);
            _ensured = true;
        }
        return _table;
    }

    // ─── IEvolutionRepository ────────────────────────────────────────────────

    public async Task UpsertAsync(EvolutionRecord record, CancellationToken ct = default)
    {
        var tableClient = await EnsuredTableAsync(ct);

        // Normalize the partition to the literal every read hard-codes ("evolution"); a record
        // persisted under any other partition would be silently unreadable.
        const string partition = "evolution";

        // §2: read-modify-write under optimistic concurrency instead of a blind
        // Upsert(Replace). The aggregate counters are monotonic, so merge with max against the
        // stored row — two concurrent evolution updates for the same DnaId can no longer clobber
        // each other's tallies. Descriptive/trait fields take the latest value.
        await TableConcurrency.UpdateWithRetryAsync<TableEntity>(
            tableClient,
            partitionKey: partition,
            rowKey: record.DnaId,
            factory: () => new TableEntity(partition, record.DnaId),
            mutate: e =>
            {
                e["DnaId"] = record.DnaId;
                e["Predatory"] = record.Predatory;
                e["Scavenger"] = record.Scavenger;
                e["Paranoid"] = record.Paranoid;
                e["Altruistic"] = record.Altruistic;
                e["Methodical"] = record.Methodical;
                e["Generation"] = record.Generation;
                e["SourceSessionId"] = record.SourceSessionId ?? "";
                e["ParentDnaIdsJson"] = record.ParentDnaIdsJson;
                e["Archetype"] = record.Archetype ?? "";
                e["DominantTrait"] = record.DominantTrait;
                if (!e.ContainsKey("CreatedAt")) e["CreatedAt"] = record.CreatedAt.ToString("O");
                e["WinCount"] = Math.Max(e.GetInt32("WinCount") ?? 0, record.WinCount);
                e["TotalSessions"] = Math.Max(e.GetInt32("TotalSessions") ?? 0, record.TotalSessions);
                e["TotalKills"] = Math.Max(e.GetInt32("TotalKills") ?? 0, record.TotalKills);
                e["TotalFoodConsumed"] = Math.Max(e.GetInt32("TotalFoodConsumed") ?? 0, record.TotalFoodConsumed);
                e["TotalDamageDealt"] = Math.Max(e.GetInt32("TotalDamageDealt") ?? 0, record.TotalDamageDealt);
                return true;
            },
            ct);
    }

    public async Task<EvolutionRecord?> GetAsync(string dnaId, CancellationToken ct = default)
    {
        var tableClient = await EnsuredTableAsync(ct);

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
        var tableClient = await EnsuredTableAsync(ct);

        var results = new List<EvolutionRecord>();
        var pages = tableClient.QueryAsync<TableEntity>(
            filter: "PartitionKey eq 'evolution'",
            maxPerPage: 1000,
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
        var tableClient = await EnsuredTableAsync(ct);

        var results = new List<EvolutionRecord>();
        var pages = tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq 'evolution' and Generation eq {generation}",
            maxPerPage: 1000,
            cancellationToken: ct);

        await foreach (var page in pages)
        {
            results.Add(MapFromEntity(page));
        }

        return results;
    }

    public async Task DeleteAllAsync(CancellationToken ct = default)
    {
        var tableClient = _table;
        var all = await GetAllAsync(ct);

        // Delete in transactional batches (max 100 actions, single partition) so the
        // operation is all-or-nothing per batch instead of a loop that can fail halfway
        // and leave the table in a partially-cleared state.
        const int batchSize = 100;
        var batch = new List<TableTransactionAction>(batchSize);
        foreach (var record in all)
        {
            batch.Add(new TableTransactionAction(
                TableTransactionActionType.Delete,
                new TableEntity("evolution", record.DnaId) { ETag = ETag.All }));

            if (batch.Count == batchSize)
            {
                await tableClient.SubmitTransactionAsync(batch, ct);
                batch.Clear();
            }
        }

        if (batch.Count > 0)
        {
            await tableClient.SubmitTransactionAsync(batch, ct);
        }
    }

    // ─── Private helpers ────────────────────────────────────────────────────

    private static EvolutionRecord MapFromEntity(TableEntity entity)
    {
        return new EvolutionRecord
        {
            PartitionKey = entity.PartitionKey,
            RowKey = entity.RowKey,
            DnaId = GetString(entity, "DnaId"),
            Predatory = GetDouble(entity, "Predatory"),
            Scavenger = GetDouble(entity, "Scavenger"),
            Paranoid = GetDouble(entity, "Paranoid"),
            Altruistic = GetDouble(entity, "Altruistic"),
            Methodical = GetDouble(entity, "Methodical"),
            Generation = GetInt(entity, "Generation"),
            SourceSessionId = GetString(entity, "SourceSessionId"),
            ParentDnaIdsJson = GetString(entity, "ParentDnaIdsJson"),
            Archetype = GetString(entity, "Archetype"),
            DominantTrait = GetString(entity, "DominantTrait"),
            CreatedAt = DateTimeOffset.TryParse(GetString(entity, "CreatedAt"), out var dt) ? dt : default,
            WinCount = GetInt(entity, "WinCount"),
            TotalSessions = GetInt(entity, "TotalSessions"),
            TotalKills = GetInt(entity, "TotalKills"),
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
