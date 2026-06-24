using System.Text.Json;
using Azure;
using Azure.Data.Tables;
using Azure.Identity;
using Microsoft.Extensions.Configuration;
using PoMiniGames.Application.DTOs;
using PoMiniGames.Application.Services;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Services;

namespace PoMiniGames.Infrastructure.Services;

/// <summary>
/// Azure Table Storage-backed storage service. In development this points at the
/// Azurite emulator (connection string "UseDevelopmentStorage=true"); in production it
/// uses a real Azure Storage account via a connection string or managed identity.
/// </summary>
public class StorageService : IStorageService
{
    private const string PlayerStatsTable = "PlayerStats";
    private const string SnakeTable = "SnakeHighScores";
    private const string DropSquareTable = "PoDropSquareHighScores";
    private const string MarbleRaceTable = "MarbleRaceHighScores";

    // High scores share a single partition per game so a leaderboard is one partition scan.
    private const string SnakePartition = "snake";
    private const string DropSquarePartition = "podropsquare";
    private const string MarbleRacePartition = "marblerace";

    private readonly TableServiceClient _serviceClient;
    private readonly EloCalculator _eloCalculator;
    private readonly HashSet<string> _ensuredTables = new();
    private readonly object _ensureLock = new();

    internal static readonly HashSet<char> _invalidChars =
        Path.GetInvalidFileNameChars()
            .Concat(new[] { '\'', '"', ';', '\\', '/', '#', '?', '\t', '\n', '\r' })
            .ToHashSet();

    public StorageService(IConfiguration configuration, EloCalculator eloCalculator)
    {
        _eloCalculator = eloCalculator;

        var section = configuration.GetSection("PoMiniGames:Storage:TableService");
        var connectionString = section["ConnectionString"];
        var endpoint = section["Endpoint"];
        var accountName = section["AccountName"];

        if (!string.IsNullOrWhiteSpace(connectionString))
        {
            _serviceClient = new TableServiceClient(connectionString);
        }
        else if (!string.IsNullOrWhiteSpace(endpoint) || !string.IsNullOrWhiteSpace(accountName))
        {
            var serviceUri = !string.IsNullOrWhiteSpace(endpoint)
                ? new Uri(endpoint!)
                : new Uri($"https://{accountName}.table.core.windows.net");
            _serviceClient = new TableServiceClient(serviceUri, new DefaultAzureCredential());
        }
        else
        {
            // Default to the Azurite emulator so local dev works out of the box.
            _serviceClient = new TableServiceClient("UseDevelopmentStorage=true");
        }
    }

    /// <summary>
    /// Best-effort eager creation of all tables at startup. If storage is briefly unreachable
    /// the app still starts; tables are also ensured lazily on first use (see <see cref="Table"/>).
    /// </summary>
    public void Initialize()
    {
        foreach (var table in new[] { PlayerStatsTable, SnakeTable, DropSquareTable, MarbleRaceTable })
        {
            try { Table(table); } catch { /* ensured lazily on first use */ }
        }
    }

    // Returns the client, creating the table once per name (cached).
    private TableClient Table(string name)
    {
        var client = _serviceClient.GetTableClient(name);
        bool firstTime;
        lock (_ensureLock)
        {
            firstTime = _ensuredTables.Add(name);
        }
        if (firstTime)
        {
            client.CreateIfNotExists();
        }
        return client;
    }

    // ── Player stats ──────────────────────────────────────────────────────

    public async Task<List<PlayerStatsDto>> GetAllPlayerStatsAsync()
    {
        var result = new List<PlayerStatsDto>();
        var table = Table(PlayerStatsTable);

        // Bound the per-network-call working set; the full-table scan still streams,
        // but never buffers more than one page of raw entities at a time.
        await foreach (var entity in table.QueryAsync<TableEntity>(maxPerPage: 1000))
        {
            var json = entity.GetString("StatsJson");
            if (string.IsNullOrEmpty(json)) continue;
            var stats = JsonSerializer.Deserialize<PlayerStats>(json) ?? new PlayerStats();
            result.Add(new PlayerStatsDto
            {
                Game = entity.PartitionKey,
                Name = entity.RowKey,
                Stats = stats,
            });
        }

        return result;
    }

    public async Task<PlayerStats?> GetPlayerStatsAsync(string game, string playerName)
    {
        var sanitizedGame = SanitizeName(game);
        var sanitizedName = SanitizeName(playerName);
        if (string.IsNullOrWhiteSpace(sanitizedGame) || string.IsNullOrWhiteSpace(sanitizedName))
        {
            return null;
        }

        try
        {
            var response = await Table(PlayerStatsTable).GetEntityAsync<TableEntity>(sanitizedGame, sanitizedName);
            var json = response.Value.GetString("StatsJson");
            return json is null ? null : JsonSerializer.Deserialize<PlayerStats>(json);
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return null;
        }
    }

    public async Task SavePlayerStatsAsync(string game, string playerName, PlayerStats stats)
    {
        var sanitizedGame = SanitizeName(game);
        var sanitizedName = SanitizeName(playerName);

        if (string.IsNullOrWhiteSpace(sanitizedGame))
        {
            throw new ArgumentException("Game cannot be empty", nameof(game));
        }

        if (string.IsNullOrWhiteSpace(sanitizedName))
        {
            throw new ArgumentException("Player name cannot be empty", nameof(playerName));
        }

        // Compute ELO ratings server-side before persisting so the stored JSON is always current.
        _eloCalculator.ApplyAll(stats);
        stats.UpdatedAt = DateTime.UtcNow;

        var entity = new TableEntity(sanitizedGame, sanitizedName)
        {
            ["StatsJson"] = JsonSerializer.Serialize(stats),
            ["UpdatedAt"] = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"),
        };

        await Table(PlayerStatsTable).UpsertEntityAsync(entity, TableUpdateMode.Replace);
    }

    public async Task<List<(string Name, PlayerStats Stats)>> GetLeaderboardAsync(string game, int limit, string? difficulty = null)
    {
        var sanitizedGame = SanitizeName(game);
        if (string.IsNullOrWhiteSpace(sanitizedGame))
        {
            return [];
        }

        // Table Storage has no server-side ordering, so scan the game's partition and rank in
        // memory. Leaderboards are small, so this is cheap.
        var rows = new List<(string Name, PlayerStats Stats)>();
        await foreach (var entity in Table(PlayerStatsTable).QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{sanitizedGame.Replace("'", "''")}'"))
        {
            var json = entity.GetString("StatsJson");
            if (string.IsNullOrEmpty(json)) continue;
            var stats = JsonSerializer.Deserialize<PlayerStats>(json) ?? new PlayerStats();

            // Backfill ELO for legacy records where EloRating was not yet stored.
            if (stats.TotalGames > 0 &&
                stats.Easy.EloRating == 0 && stats.Medium.EloRating == 0 && stats.Hard.EloRating == 0)
            {
                _eloCalculator.ApplyAll(stats);
            }

            rows.Add((entity.RowKey, stats));
        }

        var diff = difficulty?.Trim().ToLowerInvariant();
        IEnumerable<(string Name, PlayerStats Stats)> ranked = diff switch
        {
            "easy" => rows.Where(r => r.Stats.Easy.TotalGames > 0)
                          .OrderByDescending(r => r.Stats.Easy.EloRating)
                          .ThenByDescending(r => r.Stats.Easy.TotalGames),
            "medium" => rows.Where(r => r.Stats.Medium.TotalGames > 0)
                          .OrderByDescending(r => r.Stats.Medium.EloRating)
                          .ThenByDescending(r => r.Stats.Medium.TotalGames),
            "hard" => rows.Where(r => r.Stats.Hard.TotalGames > 0)
                          .OrderByDescending(r => r.Stats.Hard.EloRating)
                          .ThenByDescending(r => r.Stats.Hard.TotalGames),
            _ => rows.OrderByDescending(r => r.Stats.WinRate)
                     .ThenByDescending(r => r.Stats.TotalGames),
        };

        return ranked.Take(limit).ToList();
    }

    // ── High scores ───────────────────────────────────────────────────────
    // Each game is one descriptor; the save/get flow below is shared by all of them.

    private static readonly HighScoreDescriptor<SnakeHighScore> SnakeScores = new(
        Table: SnakeTable,
        Partition: SnakePartition,
        Sanitize: e => e with
        {
            Initials = e.Initials.Trim().ToUpperInvariant(),
            Date = DefaultDate(e.Date),
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["Initials"] = e.Initials,
            ["Score"] = e.Score,
            ["Date"] = e.Date,
            ["GameDuration"] = e.GameDuration,
            ["SnakeLength"] = e.SnakeLength,
            ["FoodEaten"] = e.FoodEaten,
        },
        FromEntity: e => new SnakeHighScore
        {
            Initials = e.GetString("Initials") ?? "",
            Score = e.GetInt32("Score") ?? 0,
            Date = e.GetString("Date") ?? "",
            GameDuration = e.GetDouble("GameDuration") ?? 30d,
            SnakeLength = e.GetInt32("SnakeLength") ?? 0,
            FoodEaten = e.GetInt32("FoodEaten") ?? 0,
        },
        // Highest score wins.
        Rank: s => s.OrderByDescending(x => x.Score));

    private static readonly HighScoreDescriptor<PoDropSquareHighScore> DropSquareScores = new(
        Table: DropSquareTable,
        Partition: DropSquarePartition,
        Sanitize: e => e with
        {
            PlayerInitials = Initials3(e.PlayerInitials),
            Date = DefaultDate(e.Date),
            PlayerName = string.IsNullOrWhiteSpace(e.PlayerName) ? null : SanitizeName(e.PlayerName),
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["PlayerInitials"] = e.PlayerInitials,
            ["SurvivalTime"] = e.SurvivalTime,
            ["Date"] = e.Date,
            ["PlayerName"] = e.PlayerName,
        },
        FromEntity: e => new PoDropSquareHighScore
        {
            PlayerInitials = e.GetString("PlayerInitials") ?? "",
            SurvivalTime = e.GetDouble("SurvivalTime") ?? 0d,
            Date = e.GetString("Date") ?? "",
            PlayerName = e.GetString("PlayerName"),
        },
        // Lowest survival time wins, oldest first as the tiebreaker.
        Rank: s => s.OrderBy(x => x.SurvivalTime).ThenBy(x => x.Date));

    private static readonly HighScoreDescriptor<MarbleRaceHighScore> MarbleRaceScores = new(
        Table: MarbleRaceTable,
        Partition: MarbleRacePartition,
        Sanitize: e => e with
        {
            PlayerInitials = Initials3(e.PlayerInitials),
            Date = DefaultDate(e.Date),
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["PlayerInitials"] = e.PlayerInitials,
            ["BestScore"] = e.BestScore,
            ["Date"] = e.Date,
            ["GameDuration"] = e.GameDuration,
        },
        FromEntity: e => new MarbleRaceHighScore
        {
            PlayerInitials = e.GetString("PlayerInitials") ?? "",
            BestScore = e.GetInt32("BestScore") ?? 0,
            Date = e.GetString("Date") ?? "",
            GameDuration = e.GetDouble("GameDuration") ?? 0d,
        },
        // Highest score wins, oldest first as the tiebreaker.
        Rank: s => s.OrderByDescending(x => x.BestScore).ThenBy(x => x.Date));

    public Task<List<SnakeHighScore>> GetSnakeHighScoresAsync(int limit = 10) =>
        GetHighScoresAsync(SnakeScores, limit);

    public Task<SnakeHighScore> SaveSnakeHighScoreAsync(SnakeHighScore entry) =>
        SaveHighScoreAsync(SnakeScores, entry);

    public Task<List<PoDropSquareHighScore>> GetPoDropSquareHighScoresAsync(int limit = 10) =>
        GetHighScoresAsync(DropSquareScores, limit);

    public Task<PoDropSquareHighScore> SavePoDropSquareHighScoreAsync(PoDropSquareHighScore entry) =>
        SaveHighScoreAsync(DropSquareScores, entry);

    public Task<List<MarbleRaceHighScore>> GetMarbleRaceHighScoresAsync(int limit = 10) =>
        GetHighScoresAsync(MarbleRaceScores, limit);

    public Task<MarbleRaceHighScore> SaveMarbleRaceHighScoreAsync(MarbleRaceHighScore entry) =>
        SaveHighScoreAsync(MarbleRaceScores, entry);

    // The one shared high-score read: scan the game's partition, rebuild entries, rank, take.
    private async Task<List<T>> GetHighScoresAsync<T>(HighScoreDescriptor<T> descriptor, int limit)
    {
        var scores = new List<T>();
        await foreach (var e in Table(descriptor.Table).QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{descriptor.Partition}'"))
        {
            scores.Add(descriptor.FromEntity(e));
        }

        return descriptor.Rank(scores).Take(limit).ToList();
    }

    // The one shared high-score write: normalise, map to a row, upsert idempotently.
    // The RowKey is derived deterministically from the row's content so a duplicate
    // HTTP request or a retry-after-timeout collapses onto the same row instead of
    // inflating the leaderboard with a second identical entry. Ranking is done in
    // memory (see GetHighScoresAsync), so RowKey ordering is irrelevant to correctness.
    private async Task<T> SaveHighScoreAsync<T>(HighScoreDescriptor<T> descriptor, T entry)
    {
        var sanitized = descriptor.Sanitize(entry);
        var fields = descriptor.ToFields(sanitized);

        var entity = new TableEntity(descriptor.Partition, DeterministicRowKey(fields));
        foreach (var (key, value) in fields)
        {
            entity[key] = value;
        }

        await Table(descriptor.Table).UpsertEntityAsync(entity, TableUpdateMode.Replace);
        return sanitized;
    }

    // Stable content hash over the row's fields → idempotent, retry-safe RowKey.
    private static string DeterministicRowKey(IDictionary<string, object?> fields)
    {
        var canonical = string.Join("", fields
            .OrderBy(kv => kv.Key, StringComparer.Ordinal)
            .Select(kv => $"{kv.Key}={Convert.ToString(kv.Value, System.Globalization.CultureInfo.InvariantCulture)}"));
        var hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(canonical));
        return Convert.ToHexStringLower(hash);
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private static string DefaultDate(string? date) =>
        string.IsNullOrWhiteSpace(date)
            ? DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
            : date;

    // Uppercased, sanitized initials truncated to 3 characters.
    private static string Initials3(string raw)
    {
        var s = SanitizeName(raw).ToUpperInvariant();
        return s.Length > 3 ? s[..3] : s;
    }


    internal static string SanitizeName(string input)
    {
        if (string.IsNullOrEmpty(input))
        {
            return string.Empty;
        }

        var sb = new System.Text.StringBuilder(input.Length);
        foreach (var c in input)
        {
            if (!_invalidChars.Contains(c) && c >= 0x20)
            {
                sb.Append(c);
            }
        }

        return sb.ToString().Trim();
    }
}
