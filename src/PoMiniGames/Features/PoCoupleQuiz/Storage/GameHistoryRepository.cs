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
        // Reverse-ticks format gives a natural reverse-chronological ordering when scanned.
        PartitionKey = "GameHistory",
        RowKey = GenerateRowKey(h.PlayedAt),
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

    private static string GenerateRowKey(DateTime dt) =>
        (DateTimeOffset.MaxValue.UtcTicks - dt.ToUniversalTime().Ticks).ToString("D19");
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
        await _table.AddEntityAsync(GameHistoryEntity.From(history), cancellationToken);
    }
}
