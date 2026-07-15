using Azure;
using Azure.Data.Tables;
using PoMiniGames.Infrastructure;
using PoMiniGames.Infrastructure.Storage;

namespace PoMiniGames.Features.PoCoupleQuiz.Storage;

// ── Public DTOs ────────────────────────────────────────────────────────────

public class Team
{
    public string Name { get; set; } = string.Empty;
    public int HighScore { get; set; }
    public int TotalQuestionsAnswered { get; set; }
    public int CorrectAnswers { get; set; }
    public DateTime LastPlayed { get; set; }
}

public class UpdateStatsRequest
{
    public int Score { get; set; }
    public int QuestionsAnswered { get; set; }
    public int CorrectAnswers { get; set; }

    /// <summary>
    /// Optional idempotency key. When supplied, a retried/duplicate PUT for the same
    /// game session is applied at most once, so the running totals cannot double-count.
    /// </summary>
    public string? GameSessionId { get; set; }
}

// ── Table entity ────────────────────────────────────────────────────────────

public class TeamTableEntity : ITableEntity
{
    public string PartitionKey { get; set; } = "Team";
    public string RowKey { get; set; } = string.Empty;
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; }
    public string Name { get; set; } = string.Empty;
    public int HighScore { get; set; }
    public DateTime LastPlayed { get; set; }
    public int TotalQuestionsAnswered { get; set; }
    public int CorrectAnswers { get; set; }

    public static TeamTableEntity From(Team team) => new()
    {
        PartitionKey = "Team",
        RowKey = team.Name.ToLowerInvariant(),
        Name = team.Name,
        HighScore = team.HighScore,
        LastPlayed = team.LastPlayed,
        TotalQuestionsAnswered = team.TotalQuestionsAnswered,
        CorrectAnswers = team.CorrectAnswers
    };

    public Team ToDomain() => new()
    {
        Name = Name,
        HighScore = HighScore,
        LastPlayed = LastPlayed,
        TotalQuestionsAnswered = TotalQuestionsAnswered,
        CorrectAnswers = CorrectAnswers
    };
}

// ── Repository ──────────────────────────────────────────────────────────────

public interface ITeamsRepository
{
    Task<Team?> GetTeamAsync(string teamName, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<Team>> GetAllTeamsAsync(CancellationToken cancellationToken = default);
    Task SaveTeamAsync(Team team, CancellationToken cancellationToken = default);
    Task UpdateStatsAsync(string teamName, int score, int questionsAnswered, int correctAnswers, string? gameSessionId = null, CancellationToken cancellationToken = default);
}

public sealed class TeamsRepository : ITeamsRepository
{
    private const string TableName = "PoCoupleQuizTeams";
    private readonly TableClient _table;

    public TeamsRepository(TableServiceClient tableServiceClient)
    {
        _table = tableServiceClient.GetTableClient(TableName);
    }

    public async Task<Team?> GetTeamAsync(string teamName, CancellationToken cancellationToken = default)
    {
        try
        {
            var response = await _table.GetEntityAsync<TeamTableEntity>("Team", teamName.ToLowerInvariant(), cancellationToken: cancellationToken);
            return response.Value.ToDomain();
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return null;
        }
    }

    public async Task<IReadOnlyList<Team>> GetAllTeamsAsync(CancellationToken cancellationToken = default)
    {
        var results = new List<Team>();
        await foreach (var entity in _table.QueryAsync<TeamTableEntity>(cancellationToken: cancellationToken))
        {
            results.Add(entity.ToDomain());
        }
        return results;
    }

    public async Task SaveTeamAsync(Team team, CancellationToken cancellationToken = default)
    {
        // Azure Table Storage requires DateTime values to be UTC. New Team
        // instances arrive with LastPlayed = DateTime.MinValue (Unspecified),
        // which the SDK rejects. Stamp UTC on the way in so any uninitialised
        // LastPlayed becomes a valid sentinel value.
        if (team.LastPlayed == default || team.LastPlayed.Kind == DateTimeKind.Unspecified)
        {
            team.LastPlayed = DateTime.UtcNow;
        }
        else if (team.LastPlayed.Kind == DateTimeKind.Local)
        {
            team.LastPlayed = team.LastPlayed.ToUniversalTime();
        }

        // §2: read-modify-write instead of a blind Upsert(Replace). A create/save must never
        // clobber the running totals that UpdateStatsAsync accumulates concurrently on the same
        // row — HighScore only ratchets up, and the answer counters are preserved unless the
        // incoming snapshot is genuinely larger (never regressed to a stale/zero value).
        var rowKey = team.Name.ToLowerInvariant();
        await TableConcurrency.UpdateWithRetryAsync<TeamTableEntity>(
            _table,
            partitionKey: "Team",
            rowKey: rowKey,
            factory: () => new TeamTableEntity { Name = team.Name },
            mutate: e =>
            {
                if (string.IsNullOrEmpty(e.Name)) e.Name = team.Name;
                e.HighScore = Math.Max(e.HighScore, team.HighScore);
                e.TotalQuestionsAnswered = Math.Max(e.TotalQuestionsAnswered, team.TotalQuestionsAnswered);
                e.CorrectAnswers = Math.Max(e.CorrectAnswers, team.CorrectAnswers);
                e.LastPlayed = team.LastPlayed;
                return true;
            },
            cancellationToken);
    }

    public async Task UpdateStatsAsync(string teamName, int score, int questionsAnswered, int correctAnswers, string? gameSessionId = null, CancellationToken cancellationToken = default)
    {
        // §3 idempotency: when a session id is supplied, claim a dedup marker in a separate
        // partition first. A retried PUT re-claims the same marker → 409 → we skip the
        // increment so the running totals never double-count. The ETag retry loop below can't
        // help here (it would re-apply the same increment), which is exactly the bug.
        var rowKey = teamName.ToLowerInvariant();
        if (!string.IsNullOrWhiteSpace(gameSessionId))
        {
            var marker = new TableEntity($"StatApplied:{rowKey}", IdempotencyKey(gameSessionId!));
            try
            {
                await _table.AddEntityAsync(marker, cancellationToken);
            }
            catch (RequestFailedException ex) when (ex.Status == 409)
            {
                return; // Already applied for this session.
            }
        }

        // Running totals: read-modify-write under optimistic concurrency so two concurrent
        // game finishes for the same team cannot lose each other's increments.
        await TableConcurrency.UpdateWithRetryAsync<TeamTableEntity>(
            _table,
            partitionKey: "Team",
            rowKey: rowKey,
            factory: () => new TeamTableEntity { Name = teamName },
            mutate: e =>
            {
                if (string.IsNullOrEmpty(e.Name)) e.Name = teamName;
                if (score > e.HighScore) e.HighScore = score;
                e.TotalQuestionsAnswered += questionsAnswered;
                e.CorrectAnswers += correctAnswers;
                e.LastPlayed = DateTime.UtcNow;
                return true;
            },
            cancellationToken);
    }

    // Stable Table-safe RowKey for a dedup marker derived from the game session id.
    private static string IdempotencyKey(string sessionId)
    {
        var hash = System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(sessionId.Trim()));
        return Convert.ToHexStringLower(hash)[..32];
    }
}
