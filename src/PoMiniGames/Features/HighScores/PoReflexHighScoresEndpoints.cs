using PoMiniGames.Application.Services;
using PoMiniGames.Domain.Models;

namespace PoMiniGames.Features.HighScores;

/// <summary>Minimal API endpoints for PoReflex reaction times (lower average is better).</summary>
public static class PoReflexHighScoresEndpoints
{
    public static IEndpointRouteBuilder MapPoReflexHighScoresEndpoints(this IEndpointRouteBuilder app)
    {
        // §1 MapGroup() per slice: PoReflex high scores share /api/poreflex/highscores.
        var reflex = app.MapGroup("/api/poreflex/highscores").WithTags("HighScores");

        reflex.MapGet("",
            async (IStorageService storage, int count = 10) =>
            {
                var scores = await storage.GetPoReflexHighScoresAsync(count);
                return Results.Ok(scores);
            })
            .WithName("GetPoReflexHighScores")
            .WithSummary("Top PoReflex reaction times (lower is better)")
            .Produces<IEnumerable<PoReflexHighScore>>(StatusCodes.Status200OK);

        reflex.MapPost("",
            async (PoReflexHighScore entry, IStorageService storage) =>
            {
                if (string.IsNullOrWhiteSpace(entry.PlayerName))
                    return Results.BadRequest(new { error = "Player name is required" });

                if (entry.PlayerName.Trim().Length > 24)
                    return Results.BadRequest(new { error = "Player name must be 24 characters or fewer" });

                if (entry.Score is <= 0 or > 60_000)
                    return Results.BadRequest(new { error = "Score must be a positive reaction time in milliseconds" });

                var saved = await storage.SavePoReflexHighScoreAsync(entry);
                return Results.Created("/api/poreflex/highscores", saved);
            })
            .WithName("SavePoReflexHighScore")
            .WithSummary("Submit a new PoReflex average reaction time")
            .Produces<PoReflexHighScore>(StatusCodes.Status201Created)
            .RequireRateLimiting("highscores");

        return app;
    }
}
