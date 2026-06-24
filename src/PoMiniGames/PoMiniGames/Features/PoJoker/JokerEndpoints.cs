using Microsoft.AspNetCore.Mvc;
using PoShared.Games.PoJoker;

namespace PoMiniGames.Features.PoJoker;

/// <summary>
/// Minimal-API surface for the PoJoker demo game: fetch a joke, analyze it with AI,
/// optionally explain it, and read the session leaderboard. The original PoJoker app
/// routed these through MediatR; here the handler logic is inlined as direct service
/// calls to match the PoMiniGames per-game endpoint convention (no MediatR dependency).
/// </summary>
public static class JokerEndpoints
{
    private const int MaxFetchRetries = 5;

    public static IEndpointRouteBuilder MapPoJokerEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/joker").WithTags("PoJoker");

        group.MapGet("/fetch", FetchJoke)
            .WithName("PoJokerFetchJoke")
            .WithSummary("Fetch a random two-part joke from JokeAPI")
            .Produces<JokeDto>()
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable);

        group.MapPost("/analyze", AnalyzeJoke)
            .WithName("PoJokerAnalyzeJoke")
            .WithSummary("Analyze a joke using AI to predict the punchline")
            .Produces<JokeAnalysisDto>()
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable);

        group.MapPost("/explain", ExplainJoke)
            .WithName("PoJokerExplainJoke")
            .WithSummary("Get an AI explanation of why a joke is funny (Comedy Coach)")
            .Produces<JokeExplanationDto>();

        group.MapGet("/leaderboard", GetLeaderboard)
            .WithName("PoJokerGetLeaderboard")
            .WithSummary("Get the top jester sessions by triumph score")
            .Produces<IReadOnlyList<LeaderboardEntryDto>>();

        return app;
    }

    private static async Task<IResult> FetchJoke(
        [FromQuery] bool safeMode,
        [FromQuery] int[]? excludeIds,
        [FromQuery] string? category,
        IJokeApiClient jokeApiClient,
        ILoggerFactory loggerFactory,
        CancellationToken cancellationToken)
    {
        var logger = loggerFactory.CreateLogger("PoJoker.Fetch");
        var resolvedCategory = string.IsNullOrWhiteSpace(category) ? "Any" : category;
        var excludeSet = excludeIds?.ToHashSet() ?? [];

        for (var retry = 0; retry < MaxFetchRetries; retry++)
        {
            var joke = await jokeApiClient.FetchJokeAsync(safeMode, excludeSet, resolvedCategory, cancellationToken);

            if (!IsValidJoke(joke))
            {
                excludeSet.Add(joke.Id);
                continue;
            }

            if (excludeSet.Count == 0 || !excludeSet.Contains(joke.Id))
            {
                return Results.Ok(joke);
            }
        }

        // After max retries, return whatever we get (may be a duplicate), or a minimal fallback.
        var fallback = await jokeApiClient.FetchJokeAsync(safeMode, null, resolvedCategory, cancellationToken);
        if (!IsValidJoke(fallback))
        {
            logger.LogWarning("PoJoker: fallback joke also invalid; returning a minimal canned joke.");
            fallback = new JokeDto
            {
                Id = 0,
                Category = "Programming",
                Type = "single",
                Setup = "The AI was silent.",
                Punchline = "It had nothing to add.",
                Flags = new JokeFlags()
            };
        }
        return Results.Ok(fallback);
    }

    private static async Task<IResult> AnalyzeJoke(
        [FromBody] JokeDto joke,
        [FromHeader(Name = "X-Session-Id")] string? sessionId,
        IAnalysisService analysisService,
        IJokeStorageClient storageClient,
        ILoggerFactory loggerFactory,
        CancellationToken cancellationToken)
    {
        var logger = loggerFactory.CreateLogger("PoJoker.Analyze");
        sessionId ??= Guid.NewGuid().ToString("N")[..8];
        var startTime = DateTimeOffset.UtcNow;

        var (analysis, rating) = await analysisService.AnalyzeJokeAsync(joke, cancellationToken);
        var result = analysis with { Rating = rating };

        // Persist for the leaderboard (best-effort; never fail the analysis on a storage error).
        try
        {
            await storageClient.SavePerformanceAsync(new JokePerformanceDto
            {
                SessionId = sessionId,
                Joke = joke,
                Analysis = result,
                StartedAt = startTime,
                CompletedAt = DateTimeOffset.UtcNow
            }, cancellationToken);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "PoJoker: failed to persist performance; leaderboard may be incomplete.");
        }

        return Results.Ok(result);
    }

    private static async Task<IResult> ExplainJoke(
        [FromBody] JokeDto joke,
        IAnalysisService analysisService,
        CancellationToken cancellationToken)
    {
        var explanation = await analysisService.ExplainJokeAsync(joke, cancellationToken);
        return Results.Ok(new JokeExplanationDto { Explanation = explanation });
    }

    private static async Task<IResult> GetLeaderboard(
        IJokeStorageClient storageClient,
        string sortBy = "Triumph",
        int top = 10,
        CancellationToken cancellationToken = default)
    {
        top = Math.Clamp(top, 1, 100);

        var entries = await storageClient.GetLeaderboardAsync(top * 2, cancellationToken);

        var sorted = sortBy?.ToUpperInvariant() switch
        {
            "TRIUMPH" => entries.OrderByDescending(e => e.Triumphs),
            _ => entries.OrderByDescending(e => e.Score)
        };

        var result = sorted
            .Take(top)
            .Select((entry, index) => entry with { Rank = index + 1 })
            .ToList();

        return Results.Ok((IReadOnlyList<LeaderboardEntryDto>)result);
    }

    private static bool IsValidJoke(JokeDto? joke) =>
        joke is not null
        && !string.IsNullOrWhiteSpace(joke.Setup)
        && !string.IsNullOrWhiteSpace(joke.Punchline);
}
