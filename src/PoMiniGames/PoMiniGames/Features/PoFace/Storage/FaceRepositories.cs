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
        await _table.UpsertEntityAsync(GameSessionEntity.From(session), TableUpdateMode.Replace, cancellationToken);
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
            .Select(r => new LeaderboardEntry { UserId = r.RowKey, Year = r.PartitionKey == "" ? year : int.Parse(r.PartitionKey), Score = r.Score, AchievedAt = r.AchievedAt })
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
        var partition = ShardOf(stats.UserId);
        var entity = new PlayerStatsEntity
        {
            PartitionKey = partition,
            RowKey = stats.UserId,
            UserId = stats.UserId,
            TotalGames = stats.TotalGames,
            TotalScore = stats.TotalScore,
            BestScore = stats.BestScore,
            HappinessBest = stats.HappinessBest,
            SurpriseBest = stats.SurpriseBest,
            AngerBest = stats.AngerBest,
            SadnessBest = stats.SadnessBest,
            FearBest = stats.FearBest,
            UpdatedAt = stats.UpdatedAt
        };
        await _table.UpsertEntityAsync(entity, TableUpdateMode.Replace, cancellationToken);
    }

    private static string ShardOf(string userId) =>
        string.IsNullOrEmpty(userId) ? "_" : userId[0].ToString().ToLowerInvariant();
}
