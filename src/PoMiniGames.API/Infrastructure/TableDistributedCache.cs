using System.Security.Cryptography;
using System.Text;
using Azure;
using Azure.Data.Tables;
using Microsoft.Extensions.Caching.Distributed;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Azure Table Storage implementation of <see cref="IDistributedCache"/>, wired as the L2 behind
/// <c>HybridCache</c> so a cached model generation outlives the host process.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why.</b> <c>AddHybridCache()</c> was registered with no <see cref="IDistributedCache"/>
/// behind it, so the "L1/L2" the registration comment advertises was L1 only — an in-process
/// memory cache. Every entry it holds is the cached result of a paid model call: PoFunQuiz's
/// 12-question batch per (category, count), PoJoker's punchline and explanation per joke,
/// PoCoupleQuiz's similarity scores. On App Service F1 the host cannot enable AlwaysOn, so it is
/// recycled whenever the site goes idle, and every one of those entries was re-generated — at full
/// generation rates — on the next visit.
/// </para>
/// <para>
/// <b>Why Table Storage rather than Redis.</b> The storage account already exists, is already
/// authenticated by the same Managed Identity, and is already ensured at startup. A cache tier
/// whose whole job is to save money should not begin by adding a paid dependency.
/// </para>
/// <para>
/// <b>Failure posture: a cache never throws.</b> Every operation swallows its exception and
/// degrades to a miss. An L2 that propagated a storage blip would turn "the cache is unavailable"
/// into "the endpoint is down", which is the opposite of what this tier is for. HybridCache's L1
/// and its stampede protection keep working regardless.
/// </para>
/// </remarks>
public sealed class TableDistributedCache : IDistributedCache
{
    /// <summary>Table name. Ensured at startup by <see cref="StorageInitializer"/>.</summary>
    public const string TableName = "PoMiniGamesCache";

    /// <summary>
    /// Table Storage caps a single binary property at 64 KiB, so a payload is split across
    /// numbered properties. Eight of them is 512 KiB, comfortably under the 1 MiB entity limit
    /// once the key and metadata columns are accounted for.
    /// </summary>
    private const int MaxChunkBytes = 64 * 1024;
    private const int MaxChunks = 8;
    private const int MaxPayloadBytes = MaxChunkBytes * MaxChunks;

    private const string ExpiresColumn = "ExpiresAtUtc";
    private const string ChunkCountColumn = "Chunks";
    private const string KeyColumn = "CacheKey";

    private readonly TableServiceClient _serviceClient;
    private readonly ILogger<TableDistributedCache> _logger;
    private readonly TimeSpan _defaultTtl;
    private TableClient? _table;
    private readonly object _tableLock = new();
    private DateTime _lastCreateAttemptUtc = DateTime.MinValue;
    private static readonly TimeSpan CreateBackoff = TimeSpan.FromSeconds(10);

    public TableDistributedCache(TableServiceClient serviceClient, ILogger<TableDistributedCache> logger)
    {
        _serviceClient = serviceClient;
        _logger = logger;
        // An entry written with no expiry at all would be immortal, and these entries hold model
        // output that should refresh when a deployment changes. HybridCache always supplies one,
        // so this is a backstop for a direct IDistributedCache caller.
        _defaultTtl = TimeSpan.FromDays(7);
    }

    public async Task<byte[]?> GetAsync(string key, CancellationToken token = default)
    {
        try
        {
            var table = await ResolveTableAsync(token);
            if (table is null) return null;
            var response = await table.GetEntityAsync<TableEntity>(
                PartitionFor(key), RowKeyFor(key), cancellationToken: token);
            var entity = response.Value;

            if (entity.GetDateTimeOffset(ExpiresColumn) is { } expires && expires <= DateTimeOffset.UtcNow)
            {
                // Lazy eviction: Table Storage has no TTL, so an expired row is removed when it is
                // next read. Rows never read again are the cost of not running a sweeper — they are
                // a few KB each and the table is not on any hot path.
                await RemoveAsync(key, token);
                return null;
            }

            return Reassemble(entity);
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return null;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Distributed cache read failed for key {Key}; treating as a miss.", Redact(key));
            return null;
        }
    }

    public async Task SetAsync(
        string key, byte[] value, DistributedCacheEntryOptions options, CancellationToken token = default)
    {
        if (value.Length > MaxPayloadBytes)
        {
            // Not an error: L1 still serves it, and the alternative — spreading one entry across
            // several rows — buys a multi-row consistency problem to cache something this app does
            // not currently produce.
            _logger.LogDebug(
                "Distributed cache skipped key {Key}: {Bytes} bytes exceeds the {Max}-byte entity budget.",
                Redact(key), value.Length, MaxPayloadBytes);
            return;
        }

        try
        {
            var table = await ResolveTableAsync(token);
            if (table is null) return;
            var entity = new TableEntity(PartitionFor(key), RowKeyFor(key))
            {
                [KeyColumn] = Truncate(key),
                [ExpiresColumn] = ExpiryFor(options),
                [ChunkCountColumn] = 0,
            };

            var written = 0;
            for (var offset = 0; offset < value.Length; offset += MaxChunkBytes)
            {
                var length = Math.Min(MaxChunkBytes, value.Length - offset);
                entity[$"D{written}"] = value.AsSpan(offset, length).ToArray();
                written++;
            }
            entity[ChunkCountColumn] = written;

            // Blind upsert (Replace). Last writer wins is the right semantic for a cache: both
            // writers computed the same key, so both values are equally valid, and an ETag loop
            // here would buy a retry to store a value we already have.
            await table.UpsertEntityAsync(entity, TableUpdateMode.Replace, token);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Distributed cache write failed for key {Key}; entry stays L1-only.", Redact(key));
        }
    }

    public async Task RemoveAsync(string key, CancellationToken token = default)
    {
        try
        {
            var table = await ResolveTableAsync(token);
            if (table is null) return;
            await table.DeleteEntityAsync(PartitionFor(key), RowKeyFor(key), ETag.All, token);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Distributed cache delete failed for key {Key}.", Redact(key));
        }
    }

    /// <summary>
    /// No-op. Refresh exists to extend a sliding expiration; entries here are written with an
    /// absolute expiry (see <see cref="ExpiryFor"/>), so there is nothing to slide.
    /// </summary>
    public Task RefreshAsync(string key, CancellationToken token = default) => Task.CompletedTask;

    // ── Synchronous surface ──────────────────────────────────────────────
    // IDistributedCache requires these; HybridCache only ever calls the async ones. They block on
    // the async path rather than duplicating it — a second, subtly different implementation of the
    // chunking is a worse hazard than a blocking call nothing makes.

    public byte[]? Get(string key) => GetAsync(key, CancellationToken.None).GetAwaiter().GetResult();

    public void Set(string key, byte[] value, DistributedCacheEntryOptions options)
        => SetAsync(key, value, options, CancellationToken.None).GetAwaiter().GetResult();

    public void Refresh(string key) { }

    public void Remove(string key) => RemoveAsync(key, CancellationToken.None).GetAwaiter().GetResult();

    private static byte[]? Reassemble(TableEntity entity)
    {
        var chunks = entity.GetInt32(ChunkCountColumn) ?? 0;
        if (chunks <= 0) return null;

        var parts = new byte[chunks][];
        var total = 0;
        for (var i = 0; i < chunks; i++)
        {
            var part = entity.GetBinary($"D{i}");
            // A missing chunk means a partially written or truncated row. Reporting a miss makes
            // the caller regenerate; returning a short buffer would hand the deserializer garbage.
            if (part is null) return null;
            parts[i] = part;
            total += part.Length;
        }

        var buffer = new byte[total];
        var offset = 0;
        foreach (var part in parts)
        {
            part.CopyTo(buffer, offset);
            offset += part.Length;
        }
        return buffer;
    }

    private DateTimeOffset ExpiryFor(DistributedCacheEntryOptions options)
    {
        var now = DateTimeOffset.UtcNow;

        if (options.AbsoluteExpiration is { } absolute)
            return absolute;
        if (options.AbsoluteExpirationRelativeToNow is { } relative)
            return now.Add(relative);
        // Sliding expiration is stored as absolute-from-write. The distinction would only matter
        // if something called Refresh, and HybridCache does not — it writes an absolute L2 lifetime
        // derived from the entry's Expiration.
        if (options.SlidingExpiration is { } sliding)
            return now.Add(sliding);

        return now.Add(_defaultTtl);
    }

    /// <summary>
    /// The table client, or null when storage is unreachable.
    /// </summary>
    /// <remarks>
    /// <b>The negative result is cached, and that is the point.</b> Without the backoff, a host
    /// running with storage down (no Azurite locally — the documented local state) would attempt
    /// <c>CreateIfNotExists</c> on every cache read and every cache write. Each attempt costs the
    /// table client's 2 s network timeout, so an L2 that exists to make requests faster would add
    /// two seconds to every one of them. Ten seconds between attempts matches the probe backoff
    /// <c>StorageService</c> already uses for the same reason, and recovery is automatic.
    /// </remarks>
    private async Task<TableClient?> ResolveTableAsync(CancellationToken cancellationToken)
    {
        var existing = Volatile.Read(ref _table);
        if (existing is not null) return existing;

        lock (_tableLock)
        {
            if (_table is not null) return _table;
            if (DateTime.UtcNow - _lastCreateAttemptUtc < CreateBackoff) return null;
            _lastCreateAttemptUtc = DateTime.UtcNow;
        }

        try
        {
            var client = _serviceClient.GetTableClient(TableName);
            await client.CreateIfNotExistsAsync(cancellationToken: cancellationToken);

            lock (_tableLock)
            {
                _table ??= client;
                return _table;
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Distributed cache table {Table} is unavailable; running L1-only.", TableName);
            return null;
        }
    }

    /// <summary>
    /// Full SHA-256 hex of the key. Cache keys are composed from game data (category names, joke
    /// text) and may contain <c>/</c>, <c>\</c>, <c>#</c> or <c>?</c>, all illegal in a Table
    /// Storage key. Hashing avoids sanitising, which could collide two distinct keys onto one row.
    /// </summary>
    private static string RowKeyFor(string key)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)));

    /// <summary>First byte of the hash as hex: 256 partitions, so writes spread rather than
    /// hot-spotting one partition server.</summary>
    private static string PartitionFor(string key) => RowKeyFor(key)[..2];

    private static string Truncate(string value) => value.Length <= 512 ? value : value[..512];

    /// <summary>
    /// Keys can embed user-supplied text (a joke setup). Log the hash, not the content.
    /// </summary>
    private static string Redact(string key) => RowKeyFor(key)[..12];
}
