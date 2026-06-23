using Azure;
using Azure.Data.Tables;
using PoMiniGames.Infrastructure;

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
    Task UpdateStatsAsync(string teamName, int score, int questionsAnswered, int correctAnswers, CancellationToken cancellationToken = default);
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
        await _table.UpsertEntityAsync(TeamTableEntity.From(team), TableUpdateMode.Replace, cancellationToken);
    }

    public async Task UpdateStatsAsync(string teamName, int score, int questionsAnswered, int correctAnswers, CancellationToken cancellationToken = default)
    {
        var team = await GetTeamAsync(teamName, cancellationToken) ?? new Team { Name = teamName };
        if (score > team.HighScore) team.HighScore = score;
        team.TotalQuestionsAnswered += questionsAnswered;
        team.CorrectAnswers += correctAnswers;
        team.LastPlayed = DateTime.UtcNow;
        await SaveTeamAsync(team, cancellationToken);
    }
}
