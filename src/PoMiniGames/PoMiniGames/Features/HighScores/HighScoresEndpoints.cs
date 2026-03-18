using PoMiniGames.Models;
using PoMiniGames.Services;

namespace PoMiniGames.Features.HighScores;

/// <summary>Consolidated Minimal API endpoints for Snake and PoDropSquare high scores.</summary>
public static class HighScoresEndpoints
{
    public static IEndpointRouteBuilder MapHighScoresEndpoints(this IEndpointRouteBuilder app)
    {
        // ─── PoSnakeGame ──────────────────────────────────────────────────────
        app.MapGet("/api/snake/highscores",
            async (IStorageService storage, int count = 10) =>
            {
                var scores = await storage.GetSnakeHighScoresAsync(count);
                return Results.Ok(scores);
            })
            .WithName("GetSnakeHighScores")
            .WithTags("HighScores")
            .WithSummary("Top PoSnakeGame high scores")
            .Produces<IEnumerable<SnakeHighScore>>(StatusCodes.Status200OK);

        app.MapPost("/api/snake/highscores",
            async (SnakeHighScore entry, IStorageService storage) =>
            {
                if (string.IsNullOrWhiteSpace(entry.Initials))
                    return Results.BadRequest(new { error = "Initials are required" });

                if (entry.Initials.Trim().Length > 3)
                    return Results.BadRequest(new { error = "Initials must be 3 characters or fewer" });

                if (entry.Score < 0)
                    return Results.BadRequest(new { error = "Score must be non-negative" });

                var saved = await storage.SaveSnakeHighScoreAsync(entry);
                return Results.Created("/api/snake/highscores", saved);
            })
            .WithName("SaveSnakeHighScore")
            .WithTags("HighScores")
            .WithSummary("Submit a new PoSnakeGame high score")
            .Produces<SnakeHighScore>(StatusCodes.Status201Created)
            .RequireRateLimiting("highscores");

        // ─── PoDropSquare ─────────────────────────────────────────────────────
        app.MapGet("/api/podropsquare/highscores",
            async (IStorageService storage, int count = 10) =>
            {
                var scores = await storage.GetPoDropSquareHighScoresAsync(count);
                return Results.Ok(scores);
            })
            .WithName("GetPoDropSquareHighScores")
            .WithTags("HighScores")
            .WithSummary("Top PoDropSquare high scores ranked by lowest survival time")
            .Produces<IEnumerable<PoDropSquareHighScore>>(StatusCodes.Status200OK);

        app.MapPost("/api/podropsquare/highscores",
            async (PoDropSquareHighScore entry, IStorageService storage) =>
            {
                if (string.IsNullOrWhiteSpace(entry.PlayerInitials))
                    return Results.BadRequest(new { error = "Player initials are required" });

                if (entry.SurvivalTime <= 0)
                    return Results.BadRequest(new { error = "Survival time must be greater than zero" });

                var saved = await storage.SavePoDropSquareHighScoreAsync(entry);
                return Results.Created("/api/podropsquare/highscores", saved);
            })
            .WithName("SavePoDropSquareHighScore")
            .WithTags("HighScores")
            .WithSummary("Submit a new PoDropSquare high score")
            .Produces<PoDropSquareHighScore>(StatusCodes.Status201Created);

        return app;
    }
}
