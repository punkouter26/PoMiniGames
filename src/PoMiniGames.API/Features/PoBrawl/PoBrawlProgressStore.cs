using System.Security.Cryptography;
using System.Text;
using Azure;
using Azure.Data.Tables;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl;

/// <summary>
/// Table <c>PoBrawlProgress</c>: one row per player (partition <c>p</c>, RowKey = a hash of the claim
/// id, the raw id kept in <c>UserId</c> for the account export/erase). Degrades like every store
/// here: a read failure is "nothing saved", a write failure is null — never an in-memory stand-in.
/// </summary>
/// <remarks>
/// A save MERGES rather than overwrites: the newer rung wins by its client timestamp, the fastest
/// KO keeps the lower time, and the clear count keeps the higher — so an old tab saving late can
/// neither roll the ladder back nor erase a record set on another device. The merge runs under
/// the row's ETag and retries a lost race.
/// </remarks>
public sealed class PoBrawlProgressStore(TableServiceClient tables, ILogger<PoBrawlProgressStore> logger)
{
    public const string TableName = "PoBrawlProgress";
    private const string Partition = "p";

    private readonly TableClient _table = tables.GetTableClient(TableName);
    private int _ensured;

    public async Task<PoBrawlProgressDto?> GetAsync(string userId, CancellationToken ct)
    {
        try
        {
            await EnsureAsync(ct);
            var row = await _table.GetEntityIfExistsAsync<TableEntity>(Partition, KeyFor(userId), cancellationToken: ct);
            return row.HasValue ? ToDto(row.Value!) : null;
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            logger.LogWarning(ex, "PoBrawl progress read failed");
            return null;
        }
    }

    public async Task<PoBrawlProgressDto?> SaveAsync(string userId, PoBrawlProgressDto incoming, CancellationToken ct)
    {
        try
        {
            await EnsureAsync(ct);
            var key = KeyFor(userId);
            for (var attempt = 0; attempt < 4; attempt++)
            {
                var existing = await _table.GetEntityIfExistsAsync<TableEntity>(Partition, key, cancellationToken: ct);
                var current = existing.HasValue ? ToDto(existing.Value!) : null;
                var merged = Merge(current, incoming);
                var entity = new TableEntity(Partition, key)
                {
                    ["UserId"] = userId,
                    ["Rung"] = merged.Rung,
                    ["BestKoSeconds"] = merged.BestKoSeconds,
                    ["Clears"] = merged.Clears,
                    ["UpdatedAtUnixMs"] = merged.UpdatedAtUnixMs,
                };
                try
                {
                    if (existing.HasValue) await _table.UpdateEntityAsync(entity, existing.Value!.ETag, TableUpdateMode.Replace, ct);
                    else await _table.AddEntityAsync(entity, ct);
                    return merged;
                }
                catch (RequestFailedException ex) when (ex.Status is 409 or 412)
                {
                    // Another save won the race: re-read and merge onto it.
                }
            }
            return null;
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            logger.LogWarning(ex, "PoBrawl progress write failed");
            return null;
        }
    }

    internal static PoBrawlProgressDto Merge(PoBrawlProgressDto? current, PoBrawlProgressDto incoming)
    {
        if (current is null) return incoming;
        var newer = incoming.UpdatedAtUnixMs >= current.UpdatedAtUnixMs ? incoming : current;
        var ko = new[] { current.BestKoSeconds, incoming.BestKoSeconds }.Where(v => v > 0).DefaultIfEmpty(0).Min();
        return new PoBrawlProgressDto
        {
            Rung = newer.Rung,
            UpdatedAtUnixMs = newer.UpdatedAtUnixMs,
            BestKoSeconds = ko,
            Clears = Math.Max(current.Clears, incoming.Clears),
        };
    }

    private static PoBrawlProgressDto ToDto(TableEntity e) => new()
    {
        Rung = e.GetInt32("Rung") ?? 0,
        BestKoSeconds = e.GetDouble("BestKoSeconds") ?? 0,
        Clears = e.GetInt32("Clears") ?? 0,
        UpdatedAtUnixMs = e.GetInt64("UpdatedAtUnixMs") ?? 0,
    };

    private static string KeyFor(string userId) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(userId.Trim().ToLowerInvariant())))[..32];

    private async Task EnsureAsync(CancellationToken ct)
    {
        if (Volatile.Read(ref _ensured) == 1) return;
        await _table.CreateIfNotExistsAsync(ct);
        Volatile.Write(ref _ensured, 1);
    }
}
