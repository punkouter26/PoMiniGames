using System.Text.Json;
using System.Runtime.CompilerServices;
using Azure;
using Azure.Data.Tables;
using Azure.Identity;
using Microsoft.Extensions.Configuration;
using PoMiniGames.Application.DTOs;
using PoMiniGames.Application.Services;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Domain.Services;
using PoMiniGames.Infrastructure.Storage;

namespace PoMiniGames.Infrastructure.Services;

/// <summary>
/// Azure Table Storage-backed storage service. In development this points at the
/// Azurite emulator (connection string "UseDevelopmentStorage=true"); in production it
/// uses a real Azure Storage account via a connection string or managed identity.
/// </summary>
public class StorageService : IStorageService
{
    private const string PlayerStatsTable = "PlayerStats";
    private const string MarbleRaceTable = "MarbleRaceHighScores";
    private const string PoBrawlTable = "PoBrawlHighScores";
    private const string PoBrawlLadderTable = "PoBrawlLadder";
    private const string PoBrawlEloTable = "PoBrawlFighterRatings";
    private const string PoRacerTable = "PoRacerHighScores";
    private const string PoSportsTable = "PoSportsHighScores";

    // High scores share a single partition per game so a leaderboard is one partition scan.
    private const string MarbleRacePartition = "marblerace";
    private const string PoBrawlPartition = "pobrawl";
    private const string PoBrawlLadderPartition = "pobrawlladder";
    private const string PoBrawlEloPartition = "pobrawlelo";
    private const string PoRacerPartition = "poracer";
    private const string PoSportsPartition = "posports";

    private readonly TableServiceClient _serviceClient;
    private readonly EloCalculator _eloCalculator;
    private readonly PairwiseEloCalculator _fighterElo;
    private readonly HashSet<string> _ensuredTables = new();
    private readonly object _ensureLock = new();

    internal static readonly HashSet<char> _invalidChars =
        Path.GetInvalidFileNameChars()
            .Concat(new[] { '\'', '"', ';', '\\', '/', '#', '?', '\t', '\n', '\r' })
            .ToHashSet();

    public StorageService(IConfiguration configuration, EloCalculator eloCalculator, PairwiseEloCalculator fighterElo)
    {
        _eloCalculator = eloCalculator;
        _fighterElo = fighterElo;

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
        foreach (var table in new[] { PlayerStatsTable, MarbleRaceTable, PoBrawlTable, PoBrawlLadderTable, PoBrawlEloTable, PoRacerTable, PoSportsTable })
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

    /// <summary>
    /// Streams every player-stats row in the table as an async sequence. The previous
    /// <c>List&lt;PlayerStatsDto&gt;</c> shape materialised the full table in memory; for
    /// the public <c>/api/statistics</c> endpoint the JSON response is also streamed
    /// (see <c>PlayerStatsEndpoints.MapGetAllPlayerStatistics</c>) so the network and
    /// the heap pressure track the page size, not the row count.
    /// </summary>
    public async IAsyncEnumerable<PlayerStatsDto> GetAllPlayerStatsAsync(
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var table = Table(PlayerStatsTable);
        await foreach (var entity in table.QueryAsync<TableEntity>(maxPerPage: 1000, cancellationToken: cancellationToken))
        {
            var json = entity.GetString("StatsJson");
            if (string.IsNullOrEmpty(json)) continue;
            var stats = JsonSerializer.Deserialize<PlayerStats>(json);
            if (stats is null) continue;
            yield return new PlayerStatsDto
            {
                Game = entity.PartitionKey,
                Name = entity.RowKey,
                Stats = stats,
            };
        }
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

        // §9: clamp client-supplied values into their legitimate ranges before they touch
        // storage. EloRating is client-authoritative for adaptive games but must stay within
        // the same band the client clamps to (100–3000); the ceiling here rejects a tampered
        // int.MaxValue that would otherwise own the leaderboard.
        ClampStats(stats);

        BackfillLegacyElo(stats);
        stats.UpdatedAt = DateTime.UtcNow;

        // §1/§2: read-modify-write under optimistic concurrency. The client sends ABSOLUTE
        // totals, so a blind replace lets a stale client regress another writer's counters.
        // We merge against the stored row — monotonic counters take the max, non-monotonic
        // fields (WinStreak, EloRating) take the latest value — so a concurrent finish can
        // never lose accumulated wins/games.
        var partition = sanitizedGame;
        var rowKey = sanitizedName;
        await TableConcurrency.UpdateWithRetryAsync<TableEntity>(
            Table(PlayerStatsTable),
            partitionKey: partition,
            rowKey: rowKey,
            factory: () => new TableEntity(partition, rowKey),
            mutate: e =>
            {
                var existingJson = e.GetString("StatsJson");
                var merged = stats;
                if (!string.IsNullOrEmpty(existingJson))
                {
                    var existing = JsonSerializer.Deserialize<PlayerStats>(existingJson);
                    if (existing is not null) merged = MergeStats(existing, stats);
                }
                var mergedJson = JsonSerializer.Serialize(merged);
                if (existingJson == mergedJson) return false; // idempotent no-op
                e["StatsJson"] = mergedJson;
                e["UpdatedAt"] = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ");
                return true;
            });
    }

    // §9: clamp each difficulty bucket into its legitimate range. Counters are non-negative;
    // EloRating is bounded to [0, 3000] (the adaptive client's own clamp ceiling).
    private static void ClampStats(PlayerStats stats)
    {
        foreach (var b in new[] { stats.Easy, stats.Medium, stats.Hard })
        {
            b.Wins = Math.Max(0, b.Wins);
            b.Losses = Math.Max(0, b.Losses);
            b.Draws = Math.Max(0, b.Draws);
            b.TotalGames = Math.Max(0, b.TotalGames);
            b.WinStreak = Math.Max(0, b.WinStreak);
            b.EloRating = Math.Clamp(b.EloRating, 0, 3000);
        }
    }

    // Backfill ELO only when the client sent none (legacy clients that never computed a
    // rating — detected as "played games but every bucket's EloRating is 0"). Clients that
    // DO send ratings — the adaptive-ELO games (ConnectFive/TicTacToe) mirror their evolving
    // skill rating into the bucket — must not have them overwritten by the legacy W/L
    // formula. Single definition shared by the save and leaderboard-read paths so the
    // legacy-record rule cannot drift between them.
    private void BackfillLegacyElo(PlayerStats stats)
    {
        if (stats.TotalGames > 0 &&
            stats.Easy.EloRating == 0 && stats.Medium.EloRating == 0 && stats.Hard.EloRating == 0)
        {
            _eloCalculator.ApplyAll(stats);
        }
    }

    // §2: merge two absolute snapshots. Monotonic counters take the max so a stale write can't
    // regress totals; WinStreak/EloRating take the incoming (latest) value.
    private static PlayerStats MergeStats(PlayerStats existing, PlayerStats incoming)
    {
        static DifficultyStats Merge(DifficultyStats e, DifficultyStats i) => new()
        {
            Wins = Math.Max(e.Wins, i.Wins),
            Losses = Math.Max(e.Losses, i.Losses),
            Draws = Math.Max(e.Draws, i.Draws),
            TotalGames = Math.Max(e.TotalGames, i.TotalGames),
            WinStreak = i.WinStreak,
            EloRating = i.EloRating,
        };
        return new PlayerStats
        {
            PlayerId = string.IsNullOrEmpty(incoming.PlayerId) ? existing.PlayerId : incoming.PlayerId,
            PlayerName = string.IsNullOrEmpty(incoming.PlayerName) ? existing.PlayerName : incoming.PlayerName,
            Easy = Merge(existing.Easy, incoming.Easy),
            Medium = Merge(existing.Medium, incoming.Medium),
            Hard = Merge(existing.Hard, incoming.Hard),
            CreatedAt = existing.CreatedAt == default ? incoming.CreatedAt : existing.CreatedAt,
            UpdatedAt = incoming.UpdatedAt,
        };
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
            filter: $"PartitionKey eq '{sanitizedGame.Replace("'", "''")}'",
            maxPerPage: 1000))
        {
            var json = entity.GetString("StatsJson");
            if (string.IsNullOrEmpty(json)) continue;
            var stats = JsonSerializer.Deserialize<PlayerStats>(json) ?? new PlayerStats();

            BackfillLegacyElo(stats);

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

    private static readonly HighScoreDescriptor<MarbleRaceHighScore> MarbleRaceScores = new(
        Table: MarbleRaceTable,
        Partition: MarbleRacePartition,
        Sanitize: e => e with
        {
            // One identity across boards: full display name (legacy rows hold initials).
            PlayerInitials = DisplayName24(e.PlayerInitials),
            UserId = e.UserId ?? "",
            BestScore = MarbleRaceScore.Clamp(e.BestScore),
            AchievedAtUtc = e.AchievedAtUtc == default ? DateTimeOffset.UtcNow : e.AchievedAtUtc,
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["PlayerInitials"] = e.PlayerInitials,
            ["UserId"] = e.UserId,
            ["IsGuest"] = e.IsGuest,
            ["BestScore"] = e.BestScore,
            // Stored as an ISO-8601 string, not a native DateTimeOffset: legacy rows wrote a
            // string, and a column holding both types breaks GetString on read.
            ["Date"] = e.AchievedAtUtc.ToString("yyyy-MM-ddTHH:mm:ssZ"),
        },
        FromEntity: e => new MarbleRaceHighScore
        {
            PlayerInitials = e.GetString("PlayerInitials") ?? "",
            // Legacy rows predate identity columns: no UserId means it can't be attributed to a
            // real account, so it reads back as a guest row.
            UserId = e.GetString("UserId") ?? "",
            IsGuest = e.GetBoolean("IsGuest") ?? true,
            BestScore = e.GetInt32("BestScore") ?? 0,
            AchievedAtUtc = DateTimeOffset.TryParse(e.GetString("Date"), out var d) ? d : default,
        },
        // Identity is the player — (UserId, IsGuest) rather than the display name, so a guest
        // can't write onto a signed-in player's row by copying their name. Deliberately NOT
        // keyed on BestScore: the client submits on every new personal best, so a session that
        // scored 10 would post 1,2,3…10 and mint ten rows, letting one player fill a board that
        // ranks "highest score wins". One row per player, ratcheted by ShouldOverwrite below.
        RowKeyFields: ["PlayerInitials", "UserId", "IsGuest"],
        // Highest score wins, oldest first as the tiebreaker.
        Rank: s => s.OrderByDescending(x => x.BestScore).ThenBy(x => x.AchievedAtUtc))
    {
        // One row per player means every submission targets the same row, so a later, worse run
        // would otherwise erase a better one. Mirrors the PoBrawl ladder's ratchet.
        ShouldOverwrite = (existing, incoming) =>
            (incoming.TryGetValue("BestScore", out var v) ? v as int? ?? 0 : 0) > (existing.GetInt32("BestScore") ?? -1),
    };

    private static readonly HighScoreDescriptor<PoBrawlHighScore> PoBrawlScores = new(
        Table: PoBrawlTable,
        Partition: PoBrawlPartition,
        Sanitize: e => e with
        {
            // One identity across boards: full display name (legacy rows hold initials).
            PlayerInitials = DisplayName24(e.PlayerInitials),
            Character = SanitizeName(e.Character),
            Date = DefaultDate(e.Date),
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["PlayerInitials"] = e.PlayerInitials,
            ["KoTimeSeconds"] = e.KoTimeSeconds,
            ["Character"] = e.Character,
            ["Date"] = e.Date,
        },
        FromEntity: e => new PoBrawlHighScore
        {
            PlayerInitials = e.GetString("PlayerInitials") ?? "",
            KoTimeSeconds = e.GetDouble("KoTimeSeconds") ?? 0d,
            Character = e.GetString("Character") ?? "",
            Date = e.GetString("Date") ?? "",
        },
        RowKeyFields: ["Character", "KoTimeSeconds", "PlayerInitials"],
        // Fastest KO wins, oldest first as the tiebreaker.
        Rank: s => s.OrderBy(x => x.KoTimeSeconds).ThenBy(x => x.Date));

    public Task<List<MarbleRaceHighScore>> GetMarbleRaceHighScoresAsync(int limit = 10) =>
        GetHighScoresAsync(MarbleRaceScores, limit);

    public Task<MarbleRaceHighScore> SaveMarbleRaceHighScoreAsync(MarbleRaceHighScore entry) =>
        SaveHighScoreAsync(MarbleRaceScores, entry);

    public Task<List<PoBrawlHighScore>> GetPoBrawlHighScoresAsync(int limit = 10) =>
        GetHighScoresAsync(PoBrawlScores, limit);

    public Task<PoBrawlHighScore> SavePoBrawlHighScoreAsync(PoBrawlHighScore entry) =>
        SaveHighScoreAsync(PoBrawlScores, entry);

    // ── PoRacer High Scores ───────────────────────────────────────────────
    // Server-side identity is authoritative: the client-supplied PlayerName
    // is replaced with the auth-cookie value before persistence. The row
    // is deduped by a hash of the immutable content (name + time + position +
    // minute-bucketed date) so retry-after-timeout collapses onto the same row.
    private static readonly HighScoreDescriptor<PoRacerHighScore> PoRacerScores = new(
        Table: PoRacerTable,
        Partition: PoRacerPartition,
        Sanitize: e => new PoRacerHighScore
        {
            PlayerName = SanitizeName(e.PlayerName),
            UserId = string.IsNullOrWhiteSpace(e.UserId) ? "" : e.UserId,
            TotalTimeSeconds = Math.Clamp(e.TotalTimeSeconds, 0.001, 3600),
            FinalPosition = Math.Clamp(e.FinalPosition, 1, 8),
            IsGuest = e.IsGuest,
            Date = DefaultDate(e.Date),
            GameCode = SanitizeName(e.GameCode),
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["PlayerName"] = e.PlayerName,
            ["UserId"] = e.UserId,
            ["TotalTimeSeconds"] = e.TotalTimeSeconds,
            ["FinalPosition"] = e.FinalPosition,
            ["IsGuest"] = e.IsGuest,
            ["Date"] = e.Date,
            ["GameCode"] = e.GameCode,
        },
        FromEntity: e => new PoRacerHighScore
        {
            PlayerName = e.GetString("PlayerName") ?? "",
            UserId = e.GetString("UserId") ?? "",
            TotalTimeSeconds = e.GetDouble("TotalTimeSeconds") ?? 0d,
            FinalPosition = e.GetInt32("FinalPosition") ?? 0,
            IsGuest = e.GetBoolean("IsGuest") ?? false,
            Date = e.GetString("Date") ?? "",
            GameCode = e.GetString("GameCode") ?? "",
        },
        RowKeyFields: ["FinalPosition", "PlayerName", "TotalTimeSeconds", "UserId"],
        // Lowest race time wins; oldest submission breaks ties.
        Rank: s => s.OrderBy(x => x.TotalTimeSeconds).ThenBy(x => x.Date));

    public Task<List<PoRacerHighScore>> GetPoRacerHighScoresAsync(int limit = 10) =>
        GetHighScoresAsync(PoRacerScores, limit);

    public Task<PoRacerHighScore> SavePoRacerHighScoreAsync(PoRacerHighScore entry) =>
        SaveHighScoreAsync(PoRacerScores, entry);

    // ── PoSports High Scores ──────────────────────────────────────────────
    // Lowest combined meet time wins. One row per player — identity-keyed like
    // MarbleRace (not score-keyed like PoRacer), because the client submits after
    // every meet: score-keyed rows would let one player fill the whole board.
    // ShouldOverwrite ratchets DOWN — a later, slower meet can't erase a PB.
    private static readonly HighScoreDescriptor<PoSportsHighScore> PoSportsScores = new(
        Table: PoSportsTable,
        Partition: PoSportsPartition,
        Sanitize: e => new PoSportsHighScore
        {
            PlayerName = DisplayName24(e.PlayerName),
            UserId = string.IsNullOrWhiteSpace(e.UserId) ? "" : e.UserId,
            IsGuest = e.IsGuest,
            TotalTimeSeconds = Math.Clamp(e.TotalTimeSeconds, 0.001, 600),
            SprintSeconds = Math.Clamp(e.SprintSeconds, 0, 300),
            HurdlesSeconds = Math.Clamp(e.HurdlesSeconds, 0, 300),
            Character = SanitizeName(e.Character),
            Date = DefaultDate(e.Date),
            GameCode = SanitizeName(e.GameCode),
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["PlayerName"] = e.PlayerName,
            ["UserId"] = e.UserId,
            ["IsGuest"] = e.IsGuest,
            ["TotalTimeSeconds"] = e.TotalTimeSeconds,
            ["SprintSeconds"] = e.SprintSeconds,
            ["HurdlesSeconds"] = e.HurdlesSeconds,
            ["Character"] = e.Character,
            ["Date"] = e.Date,
            ["GameCode"] = e.GameCode,
        },
        FromEntity: e => new PoSportsHighScore
        {
            PlayerName = e.GetString("PlayerName") ?? "",
            UserId = e.GetString("UserId") ?? "",
            // No identity columns → unattributable, so it reads back as a guest row.
            IsGuest = e.GetBoolean("IsGuest") ?? true,
            TotalTimeSeconds = e.GetDouble("TotalTimeSeconds") ?? 0d,
            SprintSeconds = e.GetDouble("SprintSeconds") ?? 0d,
            HurdlesSeconds = e.GetDouble("HurdlesSeconds") ?? 0d,
            Character = e.GetString("Character") ?? "",
            Date = e.GetString("Date") ?? "",
            GameCode = e.GetString("GameCode") ?? "",
        },
        // Identity is the player, not the score — see the MarbleRace note above.
        RowKeyFields: ["PlayerName", "UserId", "IsGuest"],
        // Fastest meet wins, oldest first as the tiebreaker.
        Rank: s => s.OrderBy(x => x.TotalTimeSeconds).ThenBy(x => x.Date))
    {
        // One row per player: only a strictly faster meet may replace the stored PB.
        ShouldOverwrite = (existing, incoming) =>
            (incoming.TryGetValue("TotalTimeSeconds", out var v) ? v as double? ?? double.MaxValue : double.MaxValue)
                < (existing.GetDouble("TotalTimeSeconds") ?? double.MaxValue),
    };

    public Task<List<PoSportsHighScore>> GetPoSportsHighScoresAsync(int limit = 10) =>
        GetHighScoresAsync(PoSportsScores, limit);

    public Task<PoSportsHighScore> SavePoSportsHighScoreAsync(PoSportsHighScore entry) =>
        SaveHighScoreAsync(PoSportsScores, entry);

    // ── PoBrawl presidents ladder ─────────────────────────────────────────
    // Unlike the high-score boards (append + dedupe by content hash), the ladder
    // keeps exactly one row per player: RowKey = sanitized player name, and
    // PresidentsBeaten only ever ratchets up. Elo/Date follow the run that set
    // (or matched) the best, so a later worse run can't erase a 10/10 clear.

    public async Task<List<PoBrawlLadderEntry>> GetPoBrawlLadderAsync(int limit = 10)
    {
        var entries = new List<PoBrawlLadderEntry>();
        await foreach (var e in Table(PoBrawlLadderTable).QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PoBrawlLadderPartition}'",
            maxPerPage: 1000))
        {
            entries.Add(new PoBrawlLadderEntry
            {
                PlayerName = e.GetString("PlayerName") ?? "",
                PresidentsBeaten = e.GetInt32("PresidentsBeaten") ?? 0,
                Elo = e.GetInt32("Elo") ?? 0,
                Date = e.GetString("Date") ?? "",
            });
        }

        // Most presidents beaten first; higher Elo breaks ties, then earliest clear.
        return entries
            .OrderByDescending(x => x.PresidentsBeaten)
            .ThenByDescending(x => x.Elo)
            .ThenBy(x => x.Date)
            .Take(limit)
            .ToList();
    }

    public async Task<PoBrawlLadderEntry> SavePoBrawlLadderAsync(PoBrawlLadderEntry entry)
    {
        var sanitized = entry with
        {
            PlayerName = SanitizeName(entry.PlayerName),
            PresidentsBeaten = Math.Clamp(entry.PresidentsBeaten, 0, 10),
            Date = DefaultDate(entry.Date),
        };

        var rowKey = sanitized.PlayerName.ToLowerInvariant();
        await TableConcurrency.UpdateWithRetryAsync<TableEntity>(
            Table(PoBrawlLadderTable),
            partitionKey: PoBrawlLadderPartition,
            rowKey: rowKey,
            factory: () => new TableEntity(PoBrawlLadderPartition, rowKey),
            mutate: e =>
            {
                var existingBest = e.GetInt32("PresidentsBeaten") ?? -1;
                if (sanitized.PresidentsBeaten < existingBest)
                {
                    return false; // A worse run never overwrites the best.
                }
                e["PlayerName"] = sanitized.PlayerName;
                e["PresidentsBeaten"] = sanitized.PresidentsBeaten;
                e["Elo"] = sanitized.Elo;
                e["Date"] = sanitized.Date;
                return true;
            });
        return sanitized;
    }

    // ── PoBrawl demo-mode fighter Elo ─────────────────────────────────────
    // One row per fighter, RowKey = canonical fighter id, so the partition is bounded at
    // PoBrawlRoster.Count rows for all time. Unlike every board above, this is not a
    // "best result wins" ratchet: a rating is an accumulator that moves both ways, so
    // every write is a read-modify-write through TableConcurrency and there is no
    // ShouldOverwrite veto to express.

    public async Task<List<PoBrawlFighterRating>> GetPoBrawlFighterRatingsAsync(int limit = 10)
    {
        var ratings = new List<PoBrawlFighterRating>();
        await foreach (var e in Table(PoBrawlEloTable).QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PoBrawlEloPartition}'",
            maxPerPage: 1000))
        {
            ratings.Add(FighterRatingFrom(e));
        }

        // Highest rating first. Matches played breaks ties ahead of the name so a fighter
        // with a real sample outranks one sitting on its seed rating, and the id is the
        // final tiebreaker to keep the order stable between reads.
        return ratings
            .OrderByDescending(r => r.Elo)
            .ThenByDescending(r => r.Matches)
            .ThenBy(r => r.FighterId, StringComparer.Ordinal)
            .Take(limit)
            .ToList();
    }

    public async Task<List<PoBrawlFighterRating>> RecordPoBrawlDemoResultAsync(
        string winnerFighterId, string loserFighterId, bool isDraw)
    {
        var winnerId = PoBrawlRoster.Canonicalize(winnerFighterId)
            ?? throw new ArgumentException($"'{winnerFighterId}' is not a rateable PoBrawl fighter.", nameof(winnerFighterId));
        var loserId = PoBrawlRoster.Canonicalize(loserFighterId)
            ?? throw new ArgumentException($"'{loserFighterId}' is not a rateable PoBrawl fighter.", nameof(loserFighterId));

        if (string.Equals(winnerId, loserId, StringComparison.Ordinal))
        {
            throw new ArgumentException("A fighter cannot fight itself.", nameof(loserFighterId));
        }

        var table = Table(PoBrawlEloTable);

        // Snapshot both ratings to price the match. Read together: they are distinct rows that
        // cannot be read atomically in any case, so sequencing them buys nothing — which is
        // exactly why the delta is applied as an increment below rather than as an absolute.
        var before = await Task.WhenAll(
            ReadFighterEloAsync(table, winnerId),
            ReadFighterEloAsync(table, loserId));

        var delta = _fighterElo.Delta(before[0], before[1], isDraw);
        var stamp = DateTime.UtcNow.ToString("o");

        // Two distinct rows, each with its own optimistic-concurrency loop, and the increments
        // commute — so the writes are independent and run together rather than back to back.
        await Task.WhenAll(
            ApplyFighterDeltaAsync(table, winnerId, delta, isDraw ? MatchResult.Draw : MatchResult.Win, stamp),
            ApplyFighterDeltaAsync(table, loserId, -delta, isDraw ? MatchResult.Draw : MatchResult.Loss, stamp));

        // Return the re-ranked board, not the two rows just written. A rating only means
        // anything against the ranking, so every caller wanted the board and had to fetch it
        // in a second round-trip; one bounded partition query replaces two point read-backs
        // here and an entire HTTP call at the client.
        return await GetPoBrawlFighterRatingsAsync();
    }

    private enum MatchResult { Win, Loss, Draw }

    /// <summary>
    /// Current stored rating for a fighter, or the configured seed when it has never fought.
    /// </summary>
    private async Task<int> ReadFighterEloAsync(TableClient table, string fighterId)
    {
        try
        {
            var entity = await table.GetEntityAsync<TableEntity>(PoBrawlEloPartition, fighterId);
            return entity.Value.GetInt32("Elo") ?? _fighterElo.SeedElo;
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return _fighterElo.SeedElo;
        }
    }

    /// <summary>
    /// Adds <paramref name="delta"/> to a fighter's stored rating and bumps its record.
    /// </summary>
    /// <remarks>
    /// The mutation reads the rating from the entity the concurrency loop just fetched, so a
    /// retry after a 412 re-applies the increment to the winner's value rather than replaying
    /// a stale absolute. This is what makes two concurrent demo matches compose instead of
    /// one clobbering the other.
    /// </remarks>
    private Task ApplyFighterDeltaAsync(
        TableClient table, string fighterId, int delta, MatchResult result, string stamp) =>
        TableConcurrency.UpdateWithRetryAsync<TableEntity>(
            table,
            partitionKey: PoBrawlEloPartition,
            rowKey: fighterId,
            factory: () => new TableEntity(PoBrawlEloPartition, fighterId),
            mutate: e =>
            {
                var current = e.GetInt32("Elo") ?? _fighterElo.SeedElo;
                e["FighterId"] = fighterId;
                // Resolved server-side every write, so a roster rename lands on the next match
                // instead of leaving the board showing a name nobody uses any more.
                e["DisplayName"] = PoBrawlRoster.DisplayName(fighterId);
                e["Elo"] = _fighterElo.ApplyDelta(current, delta);
                e["Wins"] = (e.GetInt32("Wins") ?? 0) + (result == MatchResult.Win ? 1 : 0);
                e["Losses"] = (e.GetInt32("Losses") ?? 0) + (result == MatchResult.Loss ? 1 : 0);
                e["Draws"] = (e.GetInt32("Draws") ?? 0) + (result == MatchResult.Draw ? 1 : 0);
                e["LastUpdated"] = stamp;
                return true;
            });

    private PoBrawlFighterRating FighterRatingFrom(TableEntity e)
    {
        var id = e.GetString("FighterId") ?? e.RowKey;
        return new PoBrawlFighterRating
        {
            FighterId = id,
            // Prefer the live roster name over the stored one so a rename shows immediately
            // on read; the stored column is the fallback for an id the roster has dropped.
            DisplayName = PoBrawlRoster.IsRateable(id)
                ? PoBrawlRoster.DisplayName(id)
                : e.GetString("DisplayName") ?? id,
            // Seed, not zero: a row can only exist if ApplyFighterDeltaAsync wrote the column,
            // so this is the same unreachable-fallback contract ReadFighterEloAsync uses, and
            // the two must not disagree about what "no rating stored" means.
            Elo = e.GetInt32("Elo") ?? _fighterElo.SeedElo,
            Wins = e.GetInt32("Wins") ?? 0,
            Losses = e.GetInt32("Losses") ?? 0,
            Draws = e.GetInt32("Draws") ?? 0,
            LastUpdated = e.GetString("LastUpdated") ?? "",
        };
    }

    // The one shared high-score read: scan the game's partition, rebuild entries, rank, take.
    private async Task<List<T>> GetHighScoresAsync<T>(HighScoreDescriptor<T> descriptor, int limit)
    {
        var scores = new List<T>();
        await foreach (var e in Table(descriptor.Table).QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{descriptor.Partition}'",
            maxPerPage: 1000))
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

        // §9.1 chaos-engineering hardening: hash the row's identity fields only (submitter,
        // score, game-specific measurements). Including timestamps here would mean two
        // near-simultaneous submissions of the same score produce two distinct rows — a
        // duplicate the leaderboard then has to dedupe at read time, and a vector for cheap
        // score-flooding via bursty retries.
        var rowKey = DeterministicRowKey(fields, descriptor.RowKeyFields);

        // Concurrency-safe upsert: read existing, merge, write with ETag. Bounded retry on
        // 412/409 (see TableConcurrency).
        await TableConcurrency.UpdateWithRetryAsync<TableEntity>(
            Table(descriptor.Table),
            partitionKey: descriptor.Partition,
            rowKey: rowKey,
            factory: () => new TableEntity(descriptor.Partition, rowKey),
            mutate: e =>
            {
                if (descriptor.ShouldOverwrite is not null && !descriptor.ShouldOverwrite(e, fields))
                {
                    return false;
                }

                var changed = false;
                foreach (var (key, value) in fields)
                {
                    if (!e.TryGetValue(key, out var existing) || !Equals(existing, value))
                    {
                        e[key] = value;
                        changed = true;
                    }
                }
                return changed;
            });
        return sanitized;
    }

    // Stable content hash over the row's identity fields → idempotent, retry-safe RowKey.
    // Sorted ordinal so a descriptor's RowKeyFields order can never affect the hash.
    private static string DeterministicRowKey(IDictionary<string, object?> fields, IReadOnlyList<string> rowKeyFields)
    {
        var canonical = string.Join("", rowKeyFields
            .OrderBy(s => s, StringComparer.Ordinal)
            .Select(k => fields.TryGetValue(k, out var v) ? $"{k}={Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture)}" : $"{k}="));
        var hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(canonical));
        return Convert.ToHexStringLower(hash);
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private static string DefaultDate(string? date) =>
        string.IsNullOrWhiteSpace(date)
            ? DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
            : date;

    // Full display name, capped for table hygiene. Boards show the same name the
    // GameShell header shows — never initials or ids.
    private static string DisplayName24(string raw)
    {
        var s = SanitizeName(raw);
        return s.Length > 24 ? s[..24] : s;
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
