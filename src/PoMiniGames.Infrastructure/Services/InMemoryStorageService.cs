using System.Collections.Concurrent;
using System.Globalization;
using System.Runtime.CompilerServices;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PoMiniGames.Application.DTOs;
using PoMiniGames.Application.Services;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Domain.Services;

namespace PoMiniGames.Infrastructure.Services;

/// <summary>
/// In-memory fallback for <see cref="IStorageService"/>. Used by <see cref="StorageService"/>
/// when the Azure Table Storage backend is unreachable (Azurite not running, missing
/// connection string, network down). Scores and leaderboards still work for the lifetime
/// of the process — a single page-load gets the score it submitted, and the leaderboard
/// shows whatever else is in memory — but nothing is persisted to disk, so a restart
/// starts the boards over.
/// </summary>
/// <remarks>
/// <para>
/// Why a separate class instead of branching inside <see cref="StorageService"/>? Every
/// public method on the interface is non-trivial (descriptor-driven upserts, the Elo
/// arithmetic, the rank/ratchet ordering on each board), and inlining a full duplicate
/// into <c>StorageService</c> would mix the two paths and double the maintenance burden.
/// A second implementation keeps the "what" (high-score semantics) in one place and the
/// "where" (where the bytes live) swappable.
/// </para>
/// <para>
/// Thread-safety: every collection is a <see cref="ConcurrentDictionary{TKey,TValue}"/>.
/// Reads are unguarded beyond the dictionary's own atomicity, which is enough because
/// each entry is treated as an immutable record — a "save" replaces the whole record
/// rather than mutating fields in place. Mirrors the same pattern as the production
/// storage path's read-modify-write.
/// </para>
/// <para>
/// This fallback exists ONLY for the graceful-degradation path. The DI container still
/// resolves <see cref="IStorageService"/> to <see cref="StorageService"/>; that service
/// delegates here when Azure fails. Production deploys never see this code path
/// because the health check there is Azure itself.
/// </para>
/// </remarks>
public sealed class InMemoryStorageService : IStorageService
{
    private readonly PairwiseEloCalculator _fighterElo;
    private readonly ILogger<InMemoryStorageService> _logger;

    // ── Storage ────────────────────────────────────────────────────────────
    // Each board is keyed by the same partition+rowKey shape Azure would have used.
    // PlayerStats is keyed by "{game}:{playerName}" so a single dictionary can hold
    // every game in one place (Azure gets a separate partition per game; the in-memory
    // shape is intentionally simpler).
    private readonly ConcurrentDictionary<string, PlayerStats> _playerStats = new();
    private readonly ConcurrentDictionary<string, MarbleRaceHighScore> _marbleRace = new();
    private readonly ConcurrentDictionary<string, PoBrawlHighScore> _pobrawl = new();
    private readonly ConcurrentDictionary<string, PoRacerHighScore> _poracer = new();
    private readonly ConcurrentDictionary<string, PoSportsHighScore> _posports = new();
    private readonly ConcurrentDictionary<string, PoVoxelStrikeHighScore> _povoxelstrike = new();
    private readonly ConcurrentDictionary<string, PoBrawlLadderEntry> _pobrawlLadder = new();
    private readonly ConcurrentDictionary<string, PoBrawlFighterRating> _pobrawlElo = new();

    public InMemoryStorageService(
        PairwiseEloCalculator fighterElo,
        ILogger<InMemoryStorageService>? logger = null)
    {
        _fighterElo = fighterElo;
        _logger = logger ?? NullLogger<InMemoryStorageService>.Instance;
    }

    /// <summary>
    /// Always true — this implementation is in-process, so it is by definition available.
    /// The Azure backend calls this through its own probe; here it just lets the storage
    /// health check stay Healthy while Azure is down so /api/health doesn't 503.
    /// </summary>
    public bool IsStorageHealthy() => true;

    // ── Player stats ───────────────────────────────────────────────────────

    public async IAsyncEnumerable<PlayerStatsDto> GetAllPlayerStatsAsync(
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await Task.Yield();
        foreach (var kvp in _playerStats)
        {
            cancellationToken.ThrowIfCancellationRequested();
            // Key format: "{game}:{playerName}". Split so the DTO carries the parts
            // separately, matching what the Azure path produces.
            var sep = kvp.Key.IndexOf(':');
            if (sep < 0) continue;
            yield return new PlayerStatsDto
            {
                Game = kvp.Key[..sep],
                Name = kvp.Key[(sep + 1)..],
                Stats = kvp.Value,
            };
        }
    }

    public Task<PlayerStats?> GetPlayerStatsAsync(string game, string playerName)
    {
        var key = PlayerStatsKey(game, playerName);
        _playerStats.TryGetValue(key, out var stats);
        return Task.FromResult<PlayerStats?>(stats);
    }

    public Task SavePlayerStatsAsync(string game, string playerName, PlayerStats stats)
    {
        // Mirror the Azure path's monotonic-merge rule: counters take the max so a
        // stale client cannot regress another writer's accumulated wins/games.
        // WinStreak and EloRating take the incoming (latest) value. Mirrored from
        // StorageService.MergeStats rather than calling into it, so the fallback stays
        // self-contained and the two implementations cannot drift via inheritance.
        var key = PlayerStatsKey(game, playerName);
        _playerStats.AddOrUpdate(key,
            _ => stats,
            (_, existing) => MergeStats(existing, stats));
        return Task.CompletedTask;
    }

    public Task<List<(string Name, PlayerStats Stats)>> GetLeaderboardAsync(string game, int limit, string? difficulty = null)
    {
        var prefix = game + ":";
        var rows = _playerStats
            .Where(kvp => kvp.Key.StartsWith(prefix, StringComparison.Ordinal))
            .Select(kvp => (Name: kvp.Key[prefix.Length..], Stats: kvp.Value))
            .ToList();

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
        return Task.FromResult(ranked.Take(limit).ToList());
    }

    // ── MarbleRace High Scores ────────────────────────────────────────────
    // One row per (name, userId, isGuest). Higher score wins; older submissions break ties.
    // The RowKey is the same hash the Azure path produces so the read-side comparison
    // would still work if this fallback were ever swapped back to Azure mid-session —
    // but in practice the in-memory data is lost on restart, so the equivalence is moot.
    public Task<List<MarbleRaceHighScore>> GetMarbleRaceHighScoresAsync(int limit = 10)
    {
        var ranked = _marbleRace.Values
            .OrderByDescending(x => x.BestScore)
            .ThenBy(x => x.AchievedAtUtc)
            .Take(limit)
            .ToList();
        return Task.FromResult(ranked);
    }

    public Task<MarbleRaceHighScore> SaveMarbleRaceHighScoreAsync(MarbleRaceHighScore entry)
    {
        var sanitized = entry with
        {
            PlayerInitials = DisplayName24(entry.PlayerInitials),
            UserId = entry.UserId ?? "",
            BestScore = MarbleRaceScore.Clamp(entry.BestScore),
            AchievedAtUtc = entry.AchievedAtUtc == default ? DateTimeOffset.UtcNow : entry.AchievedAtUtc,
        };
        var key = PlayerScoreKey(sanitized.PlayerInitials, sanitized.UserId, sanitized.IsGuest);
        _marbleRace.AddOrUpdate(key,
            _ => sanitized,
            (_, existing) => sanitized.BestScore > existing.BestScore ? sanitized : existing);
        return Task.FromResult(sanitized);
    }

    // ── PoBrawl High Scores (fastest KO) ──────────────────────────────────
    // Row key derived from character + KO time + name so identical runs collapse.
    public Task<List<PoBrawlHighScore>> GetPoBrawlHighScoresAsync(int limit = 10)
    {
        var ranked = _pobrawl.Values
            .OrderBy(x => x.KoTimeSeconds)
            .ThenBy(x => x.Date)
            .Take(limit)
            .ToList();
        return Task.FromResult(ranked);
    }

    public Task<PoBrawlHighScore> SavePoBrawlHighScoreAsync(PoBrawlHighScore entry)
    {
        var sanitized = entry with
        {
            PlayerInitials = DisplayName24(entry.PlayerInitials),
            Character = SanitizeName(entry.Character),
            Date = string.IsNullOrWhiteSpace(entry.Date)
                ? DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
                : entry.Date,
        };
        var key = $"{sanitized.Character}|{sanitized.KoTimeSeconds.ToString("G", CultureInfo.InvariantCulture)}|{sanitized.PlayerInitials}";
        _pobrawl[key] = sanitized;
        return Task.FromResult(sanitized);
    }

    // ── PoRacer High Scores ───────────────────────────────────────────────
    // Lowest race time wins. RowKey = FinalPosition + name + time + userId.
    public Task<List<PoRacerHighScore>> GetPoRacerHighScoresAsync(int limit = 10)
    {
        var ranked = _poracer.Values
            .OrderBy(x => x.TotalTimeSeconds)
            .ThenBy(x => x.Date)
            .Take(limit)
            .ToList();
        return Task.FromResult(ranked);
    }

    public Task<PoRacerHighScore> SavePoRacerHighScoreAsync(PoRacerHighScore entry)
    {
        // PoRacerHighScore is a class, not a record — 'with' isn't available here. Construct
        // the sanitized copy field-by-field. Mirrors the clamp set StorageService applies.
        var sanitized = new PoRacerHighScore
        {
            PlayerName = SanitizeName(entry.PlayerName),
            UserId = string.IsNullOrWhiteSpace(entry.UserId) ? "" : entry.UserId,
            TotalTimeSeconds = Math.Clamp(entry.TotalTimeSeconds, 0.001, 3600),
            FinalPosition = Math.Clamp(entry.FinalPosition, 1, 8),
            IsGuest = entry.IsGuest,
            Date = string.IsNullOrWhiteSpace(entry.Date)
                ? DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
                : entry.Date,
            GameCode = SanitizeName(entry.GameCode),
        };
        var key = $"{sanitized.FinalPosition}|{sanitized.PlayerName}|{sanitized.TotalTimeSeconds.ToString("G", CultureInfo.InvariantCulture)}|{sanitized.UserId}";
        _poracer[key] = sanitized;
        return Task.FromResult(sanitized);
    }

    // ── PoBrawl presidents ladder ─────────────────────────────────────────
    // One row per player (case-insensitive name). PresidentsBeaten only ever ratchets up.
    public Task<List<PoBrawlLadderEntry>> GetPoBrawlLadderAsync(int limit = 10)
    {
        var ranked = _pobrawlLadder.Values
            .OrderByDescending(x => x.PresidentsBeaten)
            .ThenByDescending(x => x.Elo)
            .ThenBy(x => x.Date)
            .Take(limit)
            .ToList();
        return Task.FromResult(ranked);
    }

    public Task<PoBrawlLadderEntry> SavePoBrawlLadderAsync(PoBrawlLadderEntry entry)
    {
        var sanitized = entry with
        {
            PlayerName = SanitizeName(entry.PlayerName),
            PresidentsBeaten = Math.Clamp(entry.PresidentsBeaten, 0, PoBrawlRoster.Count),
            Date = string.IsNullOrWhiteSpace(entry.Date)
                ? DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
                : entry.Date,
        };
        var key = sanitized.PlayerName.ToLowerInvariant();
        _pobrawlLadder.AddOrUpdate(key,
            _ => sanitized,
            (_, existing) => sanitized.PresidentsBeaten >= existing.PresidentsBeaten ? sanitized : existing);
        return Task.FromResult(sanitized);
    }

    // ── PoBrawl demo-mode fighter Elo ─────────────────────────────────────
    // One row per fighter (canonical id). Ratings are accumulators; matches move both sides.
    // Uses the same PairwiseEloCalculator the Azure path uses, so the in-memory Elo math
    // and the Azure Elo math are guaranteed to agree for the same match history.
    public Task<List<PoBrawlFighterRating>> GetPoBrawlFighterRatingsAsync(int limit = 10)
    {
        var ranked = _pobrawlElo.Values
            .OrderByDescending(r => r.Elo)
            .ThenByDescending(r => r.Matches)
            .ThenBy(r => r.FighterId, StringComparer.Ordinal)
            .Take(limit)
            .ToList();
        return Task.FromResult(ranked);
    }

    public Task<List<PoBrawlFighterRating>> RecordPoBrawlDemoResultAsync(
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

        var winnerBefore = _pobrawlElo.TryGetValue(winnerId, out var w) ? w.Elo : _fighterElo.SeedElo;
        var loserBefore = _pobrawlElo.TryGetValue(loserId, out var l) ? l.Elo : _fighterElo.SeedElo;

        var delta = _fighterElo.Delta(winnerBefore, loserBefore, isDraw);
        var stamp = DateTime.UtcNow.ToString("o");

        // Same two-write sequencing as the Azure path. In-process these cannot fail, so
        // no compensation is needed, but the rule still applies: rating changes are
        // zero-sum, so the winner moves first and the loser second.
        _pobrawlElo.AddOrUpdate(winnerId,
            _ => NewRating(winnerId, winnerBefore, delta, isDraw ? MatchResult.Draw : MatchResult.Win, stamp),
            (_, existing) => UpdateRating(existing, delta, isDraw ? MatchResult.Draw : MatchResult.Win, stamp));
        _pobrawlElo.AddOrUpdate(loserId,
            _ => NewRating(loserId, loserBefore, -delta, isDraw ? MatchResult.Draw : MatchResult.Loss, stamp),
            (_, existing) => UpdateRating(existing, -delta, isDraw ? MatchResult.Draw : MatchResult.Loss, stamp));

        // Re-rank in memory rather than re-deriving the whole board, matching the
        // Azure path's contract that RecordPoBrawlDemoResultAsync returns the board.
        return GetPoBrawlFighterRatingsAsync();
    }

    private PoBrawlFighterRating NewRating(string fighterId, int currentElo, int delta, MatchResult result, string stamp)
    {
        var displayName = PoBrawlRoster.IsRateable(fighterId)
            ? PoBrawlRoster.DisplayName(fighterId)
            : fighterId;
        return new PoBrawlFighterRating
        {
            FighterId = fighterId,
            DisplayName = displayName,
            Elo = _fighterElo.ApplyDelta(currentElo, delta),
            Wins = result == MatchResult.Win ? 1 : 0,
            Losses = result == MatchResult.Loss ? 1 : 0,
            Draws = result == MatchResult.Draw ? 1 : 0,
            LastUpdated = stamp,
        };
    }

    private PoBrawlFighterRating UpdateRating(PoBrawlFighterRating existing, int delta, MatchResult result, string stamp) =>
        existing with
        {
            Elo = _fighterElo.ApplyDelta(existing.Elo, delta),
            // Max(0, …) mirrors StorageService.ApplyFighterDeltaAsync's rule so a forward+undo
            // pair can never drive a counter negative.
            Wins = Math.Max(0, existing.Wins + (result == MatchResult.Win ? 1 : 0)),
            Losses = Math.Max(0, existing.Losses + (result == MatchResult.Loss ? 1 : 0)),
            Draws = Math.Max(0, existing.Draws + (result == MatchResult.Draw ? 1 : 0)),
            LastUpdated = stamp,
        };

    private enum MatchResult { Win, Loss, Draw }

    // ── PoSports High Scores ──────────────────────────────────────────────
    // Lowest combined meet time wins. One row per player — best-time ratchet.
    public Task<List<PoSportsHighScore>> GetPoSportsHighScoresAsync(int limit = 10)
    {
        var ranked = _posports.Values
            .OrderBy(x => x.TotalTimeSeconds)
            .ThenBy(x => x.Date)
            .Take(limit)
            .ToList();
        return Task.FromResult(ranked);
    }

    public Task<PoSportsHighScore> SavePoSportsHighScoreAsync(PoSportsHighScore entry)
    {
        // PoSportsHighScore is a class, not a record — 'with' isn't available. Construct the
        // sanitized copy directly. Same clamp set as StorageService.SavePoSportsHighScoreAsync.
        var sanitized = new PoSportsHighScore
        {
            PlayerName = DisplayName24(entry.PlayerName),
            UserId = string.IsNullOrWhiteSpace(entry.UserId) ? "" : entry.UserId,
            IsGuest = entry.IsGuest,
            TotalTimeSeconds = Math.Clamp(entry.TotalTimeSeconds, 0.001, 600),
            SprintSeconds = Math.Clamp(entry.SprintSeconds, 0, 300),
            HurdlesSeconds = Math.Clamp(entry.HurdlesSeconds, 0, 300),
            Character = SanitizeName(entry.Character),
            Date = string.IsNullOrWhiteSpace(entry.Date)
                ? DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
                : entry.Date,
            GameCode = SanitizeName(entry.GameCode),
        };
        var key = PlayerScoreKey(sanitized.PlayerName, sanitized.UserId, sanitized.IsGuest);
        _posports.AddOrUpdate(key,
            _ => sanitized,
            (_, existing) => sanitized.TotalTimeSeconds < existing.TotalTimeSeconds ? sanitized : existing);
        return Task.FromResult(sanitized);
    }

    // ── PoVoxelStrike High Scores ─────────────────────────────────────────
    // Highest score wins; one row per player. Ratcheted by score.
    public Task<List<PoVoxelStrikeHighScore>> GetPoVoxelStrikeHighScoresAsync(int limit = 10)
    {
        var ranked = _povoxelstrike.Values
            .OrderByDescending(x => x.Score)
            .ThenBy(x => x.AchievedAtUtc)
            .Take(limit)
            .ToList();
        return Task.FromResult(ranked);
    }

    public Task<PoVoxelStrikeHighScore> SavePoVoxelStrikeHighScoreAsync(PoVoxelStrikeHighScore entry)
    {
        var sanitized = entry with
        {
            PlayerName = DisplayName24(entry.PlayerName),
            UserId = entry.UserId ?? "",
            Score = PoVoxelStrikeScore.Clamp(entry.Score),
            SurvivalSeconds = Math.Clamp(entry.SurvivalSeconds, 0, 14_400),
            Kills = Math.Max(0, entry.Kills),
            BruteKills = Math.Max(0, entry.BruteKills),
            CrushKills = Math.Max(0, entry.CrushKills),
            VoxelsDestroyed = Math.Max(0, entry.VoxelsDestroyed),
            AchievedAtUtc = entry.AchievedAtUtc == default ? DateTimeOffset.UtcNow : entry.AchievedAtUtc,
        };
        var key = PlayerScoreKey(sanitized.PlayerName, sanitized.UserId, sanitized.IsGuest);
        _povoxelstrike.AddOrUpdate(key,
            _ => sanitized,
            (_, existing) => sanitized.Score > existing.Score ? sanitized : existing);
        return Task.FromResult(sanitized);
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    private static string PlayerStatsKey(string game, string playerName) =>
        $"{SanitizeName(game)}:{SanitizeName(playerName)}";

    private static string PlayerScoreKey(string playerName, string userId, bool isGuest) =>
        $"{SanitizeName(playerName)}|{SanitizeName(userId)}|{(isGuest ? "1" : "0")}";

    private static string DisplayName24(string raw)
    {
        var s = SanitizeName(raw);
        return s.Length > 24 ? s[..24] : s;
    }

    private static string SanitizeName(string input)
    {
        if (string.IsNullOrEmpty(input)) return string.Empty;
        var invalid = new HashSet<char>(Path.GetInvalidFileNameChars()
            .Concat(new[] { '\'', '"', ';', '\\', '/', '#', '?', '\t', '\n', '\r' }));
        var sb = new System.Text.StringBuilder(input.Length);
        foreach (var c in input)
        {
            if (!invalid.Contains(c) && c >= 0x20) sb.Append(c);
        }
        return sb.ToString().Trim();
    }

    // Mirrors StorageService.MergeStats exactly: monotonic counters take the max,
    // WinStreak and EloRating take the latest value. See the source comment in
    // StorageService for why the "latest wins" rule exists for non-monotonic fields.
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
}