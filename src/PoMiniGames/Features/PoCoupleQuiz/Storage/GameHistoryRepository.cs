using Azure;
using Azure.Data.Tables;

namespace PoMiniGames.Features.PoCoupleQuiz.Storage;

// ── Public DTO ──────────────────────────────────────────────────────────────

public class GameHistory
{
    public string GameSessionId { get; set; } = string.Empty;
    public string Team1Name { get; set; } = string.Empty;
    public string? Team2Name { get; set; }
    public int Team1Score { get; set; }
    public int Team2Score { get; set; }
    public int RoundCount { get; set; }
    public DateTime PlayedAt { get; set; } = DateTime.UtcNow;
    public string Difficulty { get; set; } = "Medium";
}

// ── Table entity ────────────────────────────────────────────────────────────

public class GameHistoryEntity : ITableEntity
{
    public string PartitionKey { get; set; } = "GameHistory";
    public string RowKey { get; set; } = string.Empty;
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; }
    public string GameSessionId { get; set; } = string.Empty;
    public string Team1Name { get; set; } = string.Empty;
    public string Team2Name { get; set; } = string.Empty;
    public int Team1Score { get; set; }
    public int Team2Score { get; set; }
    public int RoundCount { get; set; }
    public DateTime PlayedAt { get; set; }
    public string Difficulty { get; set; } = "Medium";

    public static GameHistoryEntity From(GameHistory h) => new()
    {
        // Reverse-ticks prefix gives natural reverse-chronological ordering when scanned; the
        // session-id suffix disambiguates two histories that share the same PlayedAt tick
        // (which previously collided and surfaced as a 500).
        PartitionKey = "GameHistory",
        RowKey = GenerateRowKey(h.PlayedAt, h.GameSessionId),
        GameSessionId = h.GameSessionId,
        Team1Name = h.Team1Name,
        Team2Name = h.Team2Name ?? string.Empty,
        Team1Score = h.Team1Score,
        Team2Score = h.Team2Score,
        RoundCount = h.RoundCount,
        PlayedAt = h.PlayedAt,
        Difficulty = h.Difficulty
    };

    public GameHistory ToDomain() => new()
    {
        GameSessionId = GameSessionId,
        Team1Name = Team1Name,
        Team2Name = string.IsNullOrEmpty(Team2Name) ? null : Team2Name,
        Team1Score = Team1Score,
        Team2Score = Team2Score,
        RoundCount = RoundCount,
        PlayedAt = PlayedAt,
        Difficulty = Difficulty
    };

    private static string GenerateRowKey(DateTime dt, string sessionId)
    {
        var inverse = (DateTimeOffset.MaxValue.UtcTicks - dt.ToUniversalTime().Ticks).ToString("D19");
        return $"{inverse}-{IdempotencyKey(sessionId)}";
    }

    // Stable Table-safe suffix derived from the game session id.
    internal static string IdempotencyKey(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId)) return Guid.NewGuid().ToString("N");
        var hash = System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(sessionId.Trim()));
        return Convert.ToHexStringLower(hash)[..32];
    }
}

// ── Repository ──────────────────────────────────────────────────────────────

public interface IGameHistoryRepository
{
    Task SaveGameHistoryAsync(GameHistory history, CancellationToken cancellationToken = default);
}

public sealed class GameHistoryRepository : IGameHistoryRepository
{
    private const string TableName = "PoCoupleQuizHistory";
    private readonly TableClient _table;

    public GameHistoryRepository(TableServiceClient tableServiceClient)
    {
        _table = tableServiceClient.GetTableClient(TableName);
    }

    public async Task SaveGameHistoryAsync(GameHistory history, CancellationToken cancellationToken = default)
    {
        // Idempotency: a retried POST for the same GameSessionId maps to the same RowKey, so a
        // 409 (or the deterministic collision) means it was already recorded — treat as success
        // instead of surfacing a 500 or writing a duplicate row.
        try
        {
            await _table.AddEntityAsync(GameHistoryEntity.From(history), cancellationToken);
        }
        catch (RequestFailedException ex) when (ex.Status == 409)
        {
            // Already recorded for this session id.
        }
    }
}
