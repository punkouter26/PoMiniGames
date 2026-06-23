using Azure;
using Azure.Data.Tables;

namespace PoMiniGames.Features.PoFunQuiz.Storage;

public class LeaderboardEntryEntity : ITableEntity
{
    public string PartitionKey { get; set; } = string.Empty;
    public string RowKey { get; set; } = Guid.NewGuid().ToString();
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; }
    public string PlayerName { get; set; } = string.Empty;
    public int Score { get; set; }
    public int MaxStreak { get; set; }
    public string Category { get; set; } = "General";
    public DateTime DatePlayed { get; set; }
    public int Wins { get; set; }
    public int Losses { get; set; }
}

public interface ILeaderboardRepository
{
    Task SubmitAsync(LeaderboardEntry entry, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<LeaderboardEntry>> GetTopAsync(QuestionCategory category, int top, CancellationToken cancellationToken = default);
}

public sealed class LeaderboardRepository : ILeaderboardRepository
{
    private const string TableName = "PoFunQuizPlayers";
    private readonly TableClient _table;

    public LeaderboardRepository(TableServiceClient tableServiceClient)
    {
        _table = tableServiceClient.GetTableClient(TableName);
    }

    public async Task SubmitAsync(LeaderboardEntry entry, CancellationToken cancellationToken = default)
    {
        // Server-side sanitization: override any client-supplied PlayerName with the
        // authenticated user. The caller is responsible for setting PlayerName to
        // the email claim (or "anon-<guid>" for guest mode) before invoking.
        var entity = new LeaderboardEntryEntity
        {
            PartitionKey = entry.Category.ToString(),
            RowKey = Guid.NewGuid().ToString(),
            PlayerName = Truncate(Sanitize(entry.PlayerName), 32),
            Score = Math.Clamp(entry.Score, 0, 10_000), // hard cap
            MaxStreak = Math.Max(0, entry.MaxStreak),
            Category = entry.Category.ToString(),
            DatePlayed = entry.DatePlayed == default ? DateTime.UtcNow : entry.DatePlayed,
            Wins = Math.Max(0, entry.Wins),
            Losses = Math.Max(0, entry.Losses)
        };
        await _table.AddEntityAsync(entity, cancellationToken);
    }

    public async Task<IReadOnlyList<LeaderboardEntry>> GetTopAsync(QuestionCategory category, int top, CancellationToken cancellationToken = default)
    {
        top = Math.Clamp(top, 1, 100);
        var rows = new List<LeaderboardEntryEntity>();
        // Table Storage has no server-side ORDER BY. Scan the partition and rank in memory.
        await foreach (var entity in _table.QueryAsync<LeaderboardEntryEntity>(
            filter: $"PartitionKey eq '{category.ToString().Replace("'", "''")}'",
            cancellationToken: cancellationToken))
        {
            rows.Add(entity);
        }
        return rows
            .OrderByDescending(r => r.Score)
            .ThenByDescending(r => r.MaxStreak)
            .ThenByDescending(r => r.DatePlayed)
            .Take(top)
            .Select(r => new LeaderboardEntry
            {
                PlayerName = r.PlayerName,
                Score = r.Score,
                MaxStreak = r.MaxStreak,
                Category = Enum.TryParse<QuestionCategory>(r.Category, out var c) ? c : QuestionCategory.General,
                DatePlayed = r.DatePlayed,
                Wins = r.Wins,
                Losses = r.Losses
            })
            .ToList();
    }

    private static string Sanitize(string s) => System.Text.RegularExpressions.Regex.Replace(s ?? string.Empty, "<.*?>", string.Empty);
    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
