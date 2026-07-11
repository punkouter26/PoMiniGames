using Azure;
using Azure.Data.Tables;
using PoMiniGames.Infrastructure.Storage;

namespace PoMiniGames.Features.PoFace.Storage;

// ── GameSession entity ──────────────────────────────────────────────────────

public class GameSessionEntity : ITableEntity
{
    public string PartitionKey { get; set; } = string.Empty; // = UserId
    public string RowKey { get; set; } = string.Empty; // = SessionId
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; }
    public string UserId { get; set; } = string.Empty;
    public string SessionId { get; set; } = string.Empty;
    public int TotalScore { get; set; }
    public bool IsComplete { get; set; }
    public string CapturesJson { get; set; } = "[]";
    public DateTime CreatedAt { get; set; }
    public DateTime? ExpiresAt { get; set; }

    public static GameSessionEntity From(GameSession s) => new()
    {
        PartitionKey = s.UserId,
        RowKey = s.SessionId,
        UserId = s.UserId,
        SessionId = s.SessionId,
        TotalScore = s.TotalScore,
        IsComplete = s.IsComplete,
        CapturesJson = System.Text.Json.JsonSerializer.Serialize(s.Captures),
        CreatedAt = s.CreatedAt,
        ExpiresAt = s.ExpiresAt
    };
}

public interface IGameSessionRepository
{
    Task SaveAsync(GameSession session, CancellationToken cancellationToken = default);
    Task<GameSession?> GetAsync(string userId, string sessionId, CancellationToken cancellationToken = default);
}

public sealed class GameSessionRepository : IGameSessionRepository
{
    private const string TableName = "PoFaceGameSessions";
    private readonly TableClient _table;

    public GameSessionRepository(TableServiceClient tableServiceClient) => _table = tableServiceClient.GetTableClient(TableName);

    public async Task SaveAsync(GameSession session, CancellationToken cancellationToken = default)
    {
        // §1: optimistic-concurrency save so a concurrent capture-arrival and a round-end
        // score update cannot clobber each other's fields on the same session row.
        var partition = session.UserId;
        var rowKey = session.SessionId;
        await TableConcurrency.UpdateWithRetryAsync<GameSessionEntity>(
            _table,
            partitionKey: partition,
            rowKey: rowKey,
            factory: () => new GameSessionEntity { UserId = session.UserId, SessionId = session.SessionId },
            mutate: e =>
            {
                var fromEntity = GameSessionEntity.From(session);
                e.UserId = fromEntity.UserId;
                e.SessionId = fromEntity.SessionId;
                e.TotalScore = fromEntity.TotalScore;
                e.IsComplete = fromEntity.IsComplete;
                e.CapturesJson = fromEntity.CapturesJson;
                e.CreatedAt = fromEntity.CreatedAt;
                e.ExpiresAt = fromEntity.ExpiresAt;
                return true;
            },
            cancellationToken);
    }

    public async Task<GameSession?> GetAsync(string userId, string sessionId, CancellationToken cancellationToken = default)
    {
        try
        {
            var response = await _table.GetEntityAsync<GameSessionEntity>(userId, sessionId, cancellationToken: cancellationToken);
            var e = response.Value;
            var captures = System.Text.Json.JsonSerializer.Deserialize<List<RoundCapture>>(e.CapturesJson) ?? new();
            return new GameSession
            {
                UserId = e.UserId,
                SessionId = e.SessionId,
                Captures = captures,
                IsComplete = e.IsComplete,
                CreatedAt = e.CreatedAt,
                ExpiresAt = e.ExpiresAt
            };
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return null;
        }
    }
}

// ── Leaderboard entity ──────────────────────────────────────────────────────

public class LeaderboardEntity : ITableEntity
{
    public string PartitionKey { get; set; } = string.Empty; // = Year
    public string RowKey { get; set; } = string.Empty; // = UserId
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; }
    public int Score { get; set; }
    public DateTime AchievedAt { get; set; }
    /// <summary>Human-readable player name — boards display this, never the UserId.</summary>
    public string DisplayName { get; set; } = string.Empty;
}

public interface ILeaderboardRepository
{
    Task UpsertBestAsync(LeaderboardEntry entry, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<LeaderboardEntry>> GetTopAsync(int year, int top, CancellationToken cancellationToken = default);
}

public sealed class LeaderboardRepository : ILeaderboardRepository
{
    private const string TableName = "PoFaceLeaderboard";
    private readonly TableClient _table;

    public LeaderboardRepository(TableServiceClient tableServiceClient) => _table = tableServiceClient.GetTableClient(TableName);

    public async Task UpsertBestAsync(LeaderboardEntry entry, CancellationToken cancellationToken = default)
    {
        // BestMatchUpsertStrategy: a strictly higher score replaces the existing one.
        // Done under optimistic concurrency so a concurrent higher score is never silently
        // overwritten by a lower one (the previous read-then-blind-upsert allowed inversion).
        await TableConcurrency.UpdateWithRetryAsync<LeaderboardEntity>(
            _table,
            partitionKey: entry.Year.ToString(),
            rowKey: entry.UserId,
            factory: () => new LeaderboardEntity { Score = int.MinValue },
            mutate: e =>
            {
                if (entry.Score <= e.Score) return false; // existing is better or equal — no write
                e.Score = entry.Score;
                e.AchievedAt = entry.AchievedAt == default ? DateTime.UtcNow : entry.AchievedAt;
                if (!string.IsNullOrWhiteSpace(entry.DisplayName)) e.DisplayName = entry.DisplayName;
                return true;
            },
            cancellationToken);
    }

    public async Task<IReadOnlyList<LeaderboardEntry>> GetTopAsync(int year, int top, CancellationToken cancellationToken = default)
    {
        top = Math.Clamp(top, 1, 500);
        var rows = new List<LeaderboardEntity>();
        await foreach (var entity in _table.QueryAsync<LeaderboardEntity>(
            filter: $"PartitionKey eq '{year.ToString().Replace("'", "''")}'",
            cancellationToken: cancellationToken))
        {
            rows.Add(entity);
        }
        return rows.OrderByDescending(r => r.Score).ThenByDescending(r => r.AchievedAt).Take(top)
            .Select(r => new LeaderboardEntry
            {
                UserId = r.RowKey,
                DisplayName = r.DisplayName,
                Year = r.PartitionKey == "" ? year : int.Parse(r.PartitionKey),
                Score = r.Score,
                AchievedAt = r.AchievedAt,
            })
            .ToList();
    }
}

// ── PlayerStats entity (sharded by first char of UserId) ────────────────────

public class PlayerStatsEntity : ITableEntity
{
    public string PartitionKey { get; set; } = string.Empty; // = first char of UserId
    public string RowKey { get; set; } = string.Empty; // = UserId
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; }
    public string UserId { get; set; } = string.Empty;
    public int TotalGames { get; set; }
    public int TotalScore { get; set; }
    public int BestScore { get; set; }
    public int HappinessBest { get; set; }
    public int SurpriseBest { get; set; }
    public int AngerBest { get; set; }
    public int SadnessBest { get; set; }
    public int FearBest { get; set; }
    public DateTime UpdatedAt { get; set; }
}

public interface IPlayerStatsRepository
{
    Task<PlayerStats?> GetAsync(string userId, CancellationToken cancellationToken = default);
    Task SaveAsync(PlayerStats stats, CancellationToken cancellationToken = default);
}

public sealed class PlayerStatsRepository : IPlayerStatsRepository
{
    private const string TableName = "PoFacePlayerStats";
    private readonly TableClient _table;

    public PlayerStatsRepository(TableServiceClient tableServiceClient) => _table = tableServiceClient.GetTableClient(TableName);

    public async Task<PlayerStats?> GetAsync(string userId, CancellationToken cancellationToken = default)
    {
        var partition = ShardOf(userId);
        try
        {
            var response = await _table.GetEntityAsync<PlayerStatsEntity>(partition, userId, cancellationToken: cancellationToken);
            var e = response.Value;
            return new PlayerStats
            {
                UserId = e.UserId, TotalGames = e.TotalGames, TotalScore = e.TotalScore, BestScore = e.BestScore,
                HappinessBest = e.HappinessBest, SurpriseBest = e.SurpriseBest, AngerBest = e.AngerBest,
                SadnessBest = e.SadnessBest, FearBest = e.FearBest, UpdatedAt = e.UpdatedAt
            };
        }
        catch (RequestFailedException ex) when (ex.Status == 404) { return null; }
    }

    public async Task SaveAsync(PlayerStats stats, CancellationToken cancellationToken = default)
    {
        // §1: read-modify-write under optimistic concurrency. PlayerStats carries
        // counters (TotalGames, TotalScore, BestScore) so two games finishing at the
        // same instant cannot lose an increment to a blind Replace.
        var partition = ShardOf(stats.UserId);
        await TableConcurrency.UpdateWithRetryAsync<PlayerStatsEntity>(
            _table,
            partitionKey: partition,
            rowKey: stats.UserId,
            factory: () => new PlayerStatsEntity { UserId = stats.UserId },
            mutate: e =>
            {
                e.UserId = stats.UserId;
                e.TotalGames = stats.TotalGames;
                e.TotalScore = stats.TotalScore;
                e.BestScore = Math.Max(e.BestScore, stats.BestScore);
                e.HappinessBest = Math.Max(e.HappinessBest, stats.HappinessBest);
                e.SurpriseBest = Math.Max(e.SurpriseBest, stats.SurpriseBest);
                e.AngerBest = Math.Max(e.AngerBest, stats.AngerBest);
                e.SadnessBest = Math.Max(e.SadnessBest, stats.SadnessBest);
                e.FearBest = Math.Max(e.FearBest, stats.FearBest);
                e.UpdatedAt = stats.UpdatedAt;
                return true;
            },
            cancellationToken);
    }

    private static string ShardOf(string userId) =>
        string.IsNullOrEmpty(userId) ? "_" : userId[0].ToString().ToLowerInvariant();
}
