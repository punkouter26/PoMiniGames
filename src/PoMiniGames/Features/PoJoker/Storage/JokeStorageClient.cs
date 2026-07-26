using Azure;
using Azure.Data.Tables;
using PoShared.Games.PoJoker;

namespace PoMiniGames.Features.PoJoker.Storage;

/// <summary>
/// Joke performance persistence on Azure Table Storage. Injects the shared
/// <see cref="TableServiceClient"/> registered by <c>AddPoMiniGamesStorage</c> and resolves the
/// <see cref="TableName"/> table — same pattern as PoFunQuiz's LeaderboardRepository.
/// </summary>
public sealed class JokeStorageClient : IJokeStorageClient
{
    /// <summary>Table name. Ensured eagerly by <c>StorageInitializer</c>.</summary>
    public const string TableName = "PoJokerPerformances";

    private readonly TableClient _tableClient;
    private readonly ILogger<JokeStorageClient> _logger;

    public JokeStorageClient(TableServiceClient tableServiceClient, ILogger<JokeStorageClient> logger)
    {
        _tableClient = tableServiceClient.GetTableClient(TableName);
        _logger = logger;
    }

    public async Task SavePerformanceAsync(JokePerformanceDto performance, CancellationToken cancellationToken = default)
    {
        // §1: performances are append-only so an AddEntity is the correct semantic,
        // but a duplicate Id (retry-after-OK) would 409 and surface to the caller. Wrap
        // in a tolerant insert-or-noop so the demo orchestrator can safely re-publish.
        var entity = MapToEntity(performance);
        try
        {
            await _tableClient.AddEntityAsync(entity, cancellationToken);
            _logger.LogDebug("Saved performance {PerformanceId} for session {SessionId}", performance.Id, performance.SessionId);
        }
        catch (RequestFailedException ex) when (ex.Status == 409)
        {
            // Already exists — idempotent retry path.
            _logger.LogDebug("Performance {PerformanceId} already persisted; treating duplicate submit as success.", performance.Id);
        }
        catch (RequestFailedException ex)
        {
            _logger.LogError(ex, "Failed to save performance {PerformanceId}", performance.Id);
            throw;
        }
    }

    public async Task<IReadOnlyList<JokePerformanceDto>> GetSessionPerformancesAsync(
        string sessionId,
        CancellationToken cancellationToken = default)
    {
        var performances = new List<JokePerformanceDto>();
        try
        {
            await foreach (var entity in _tableClient.QueryAsync<JokePerformanceEntity>(
                filter: $"PartitionKey eq '{sessionId.Replace("'", "''")}'",
                cancellationToken: cancellationToken))
            {
                performances.Add(MapToDto(entity));
            }
        }
        catch (RequestFailedException ex)
        {
            _logger.LogWarning(ex, "Failed to get performances for session {SessionId}; returning an empty result.", sessionId);
            return [];
        }
        return performances;
    }

    public async Task<IReadOnlyList<LeaderboardEntryDto>> GetLeaderboardAsync(
        int top = 10,
        CancellationToken cancellationToken = default)
    {
        var sessionStats = new Dictionary<string, (int Total, int Triumphs, DateTimeOffset LastCompleted)>();
        try
        {
            // §6: this is an unpartitioned table scan that aggregates every performance row per
            // request — it grows with total history. maxPerPage bounds the per-request memory
            // spike; a pre-rolled per-session aggregate row is the follow-up if this table gets
            // large. (Kept as a scan for now to preserve exact aggregate semantics.)
            await foreach (var entity in _tableClient.QueryAsync<JokePerformanceEntity>(
                maxPerPage: 1000, cancellationToken: cancellationToken))
            {
                if (!sessionStats.TryGetValue(entity.SessionId, out var stats))
                {
                    stats = (0, 0, DateTimeOffset.MinValue);
                }

                sessionStats[entity.SessionId] = (
                    stats.Total + 1,
                    stats.Triumphs + (entity.IsTriumph ? 1 : 0),
                    entity.CompletedAt > stats.LastCompleted ? entity.CompletedAt : stats.LastCompleted
                );
            }
        }
        catch (RequestFailedException ex)
        {
            _logger.LogWarning(ex, "Failed to get leaderboard from table storage; returning an empty leaderboard.");
            return [];
        }

        return sessionStats
            .Where(kvp => kvp.Value.Triumphs > 0)  // NetRun10 audit #3: drop zero-triumph
                                                   // sessions so the leaderboard never shows
                                                   // a 0/0%/0.0 ghost champion row.
            .Select(kvp =>
            {
                var triumphRate = kvp.Value.Total > 0
                    ? Math.Round((double)kvp.Value.Triumphs / kvp.Value.Total, 4)
                    : 0;

                return new LeaderboardEntryDto
                {
                    SessionId = kvp.Key,
                    TotalJokes = kvp.Value.Total,
                    Triumphs = kvp.Value.Triumphs,
                    TriumphRate = triumphRate,
                    Score = (kvp.Value.Triumphs * 100) + (triumphRate * 1000),
                    CompletedAt = kvp.Value.LastCompleted
                };
            })
            .OrderByDescending(e => e.Score)
            .Take(top)
            .Select((e, i) => e with { Rank = i + 1 })
            .ToList();
    }

    private static string GenerateRowKey(DateTimeOffset timestamp, Guid performanceId)
    {
        var invertedTicks = DateTimeOffset.MaxValue.Ticks - timestamp.Ticks;
        return $"{invertedTicks:D19}_{performanceId:N}";
    }

    private static JokePerformanceEntity MapToEntity(JokePerformanceDto dto) => new()
    {
        PartitionKey = dto.SessionId,
        RowKey = GenerateRowKey(dto.CompletedAt, dto.Id),
        PerformanceId = dto.Id.ToString(),
        SessionId = dto.SessionId,
        SequenceNumber = dto.SequenceNumber,
        JokeId = dto.Joke.Id,
        JokeCategory = dto.Joke.Category,
        JokeType = dto.Joke.Type,
        JokeSetup = dto.Joke.Setup,
        JokePunchline = dto.Joke.Punchline,
        JokeText = dto.Joke.Joke,
        SafeMode = dto.Joke.SafeMode,
        AiPunchline = dto.Analysis.AiPunchline,
        Confidence = dto.Analysis.Confidence,
        IsTriumph = dto.Analysis.IsTriumph,
        SimilarityScore = dto.Analysis.SimilarityScore,
        AiLatencyMs = dto.Analysis.LatencyMs,
        StartedAt = dto.StartedAt,
        CompletedAt = dto.CompletedAt,
        DurationMs = dto.DurationMs,
        FlagNsfw = dto.Joke.Flags.Nsfw,
        FlagReligious = dto.Joke.Flags.Religious,
        FlagPolitical = dto.Joke.Flags.Political,
        FlagRacist = dto.Joke.Flags.Racist,
        FlagSexist = dto.Joke.Flags.Sexist,
        FlagExplicit = dto.Joke.Flags.Explicit,
        RatingCleverness = dto.Analysis.Rating?.Cleverness ?? 0,
        RatingRudeness = dto.Analysis.Rating?.Rudeness ?? 0,
        RatingComplexity = dto.Analysis.Rating?.Complexity ?? 0,
        RatingDifficulty = dto.Analysis.Rating?.Difficulty ?? 0,
        RatingAverage = dto.Analysis.Rating?.Average ?? 0.0,
        RatingCommentary = dto.Analysis.Rating?.Commentary ?? string.Empty
    };

    private static JokePerformanceDto MapToDto(JokePerformanceEntity entity)
    {
        var joke = new JokeDto
        {
            Id = entity.JokeId,
            Category = entity.JokeCategory,
            Type = entity.JokeType,
            Setup = entity.JokeSetup,
            Punchline = entity.JokePunchline,
            Joke = entity.JokeText,
            SafeMode = entity.SafeMode,
            Flags = new JokeFlags
            {
                Nsfw = entity.FlagNsfw,
                Religious = entity.FlagReligious,
                Political = entity.FlagPolitical,
                Racist = entity.FlagRacist,
                Sexist = entity.FlagSexist,
                Explicit = entity.FlagExplicit
            }
        };

        JokeRatingDto? rating = null;
        if (entity.RatingCleverness > 0 || entity.RatingRudeness > 0 || entity.RatingComplexity > 0 || entity.RatingDifficulty > 0)
        {
            rating = new JokeRatingDto
            {
                Cleverness = entity.RatingCleverness,
                Rudeness = entity.RatingRudeness,
                Complexity = entity.RatingComplexity,
                Difficulty = entity.RatingDifficulty,
                Commentary = entity.RatingCommentary
            };
        }

        var analysis = new JokeAnalysisDto
        {
            Id = Guid.TryParse(entity.PerformanceId, out var id) ? id : Guid.NewGuid(),
            OriginalJoke = joke,
            AiPunchline = entity.AiPunchline,
            Confidence = entity.Confidence,
            IsTriumph = entity.IsTriumph,
            SimilarityScore = entity.SimilarityScore,
            LatencyMs = entity.AiLatencyMs,
            AnalyzedAt = entity.CompletedAt,
            Rating = rating
        };

        return new JokePerformanceDto
        {
            Id = Guid.TryParse(entity.PerformanceId, out var perfId) ? perfId : Guid.NewGuid(),
            SessionId = entity.SessionId,
            Joke = joke,
            Analysis = analysis,
            SequenceNumber = entity.SequenceNumber,
            StartedAt = entity.StartedAt,
            CompletedAt = entity.CompletedAt,
            State = PerformanceState.Transitioning
        };
    }
}
