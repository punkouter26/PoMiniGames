using PoMiniGames.Application.Services;
using PoMiniGames.Domain.Models;

namespace PoMiniGames.Features.HighScores;

/// <summary>Minimal API endpoints for PoClick accuracy high scores (higher is better).</summary>
public static class PoClickHighScoresEndpoints
{
    public static IEndpointRouteBuilder MapPoClickHighScoresEndpoints(this IEndpointRouteBuilder app)
    {
        // §1 MapGroup() per slice: PoClick high scores share /api/poclick/highscores.
        var click = app.MapGroup("/api/poclick/highscores").WithTags("HighScores");

        click.MapGet("",
            async (IStorageService storage, int count = 10) =>
            {
                var scores = await storage.GetPoClickHighScoresAsync(count);
                return Results.Ok(scores);
            })
            .WithName("GetPoClickHighScores")
            .WithSummary("Top PoClick accuracy scores")
            .Produces<IEnumerable<PoClickHighScore>>(StatusCodes.Status200OK);

        click.MapPost("",
            async (PoClickHighScore entry, IStorageService storage) =>
            {
                if (string.IsNullOrWhiteSpace(entry.PlayerName))
                    return Results.BadRequest(new { error = "Player name is required" });

                if (entry.PlayerName.Trim().Length > 24)
                    return Results.BadRequest(new { error = "Player name must be 24 characters or fewer" });

                if (entry.Score is < 0 or > 100)
                    return Results.BadRequest(new { error = "Score must be between 0 and 100" });

                var saved = await storage.SavePoClickHighScoreAsync(entry);
                return Results.Created("/api/poclick/highscores", saved);
            })
            .WithName("SavePoClickHighScore")
            .WithSummary("Submit a new PoClick accuracy score")
            .Produces<PoClickHighScore>(StatusCodes.Status201Created)
            .RequireRateLimiting("highscores");

        return app;
    }
}
