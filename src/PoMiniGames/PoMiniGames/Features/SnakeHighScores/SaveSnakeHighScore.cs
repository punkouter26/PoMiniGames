using PoMiniGames.Models;
using PoMiniGames.Services;

namespace PoMiniGames.Features.SnakeHighScores;

/// <summary>Submit a new PoSnakeGame high score.</summary>
public static class SaveSnakeHighScoreEndpoint
{
    public static IEndpointRouteBuilder MapSaveSnakeHighScore(this IEndpointRouteBuilder app)
    {
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
            .WithTags("SnakeHighScores")
            .WithSummary("Submit a new PoSnakeGame high score")
            .Produces<SnakeHighScore>(StatusCodes.Status201Created)
            .RequireRateLimiting("highscores");

        return app;
    }
}

