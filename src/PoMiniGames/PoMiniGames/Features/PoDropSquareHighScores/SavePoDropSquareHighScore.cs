using PoMiniGames.Models;
using PoMiniGames.Services;

namespace PoMiniGames.Features.PoDropSquareHighScores;

/// <summary>Submit a new PoDropSquare high-score entry.</summary>
public static class SavePoDropSquareHighScoreEndpoint
{
    public static IEndpointRouteBuilder MapSavePoDropSquareHighScore(this IEndpointRouteBuilder app)
    {
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
            .WithTags("PoDropSquareHighScores")
            .WithSummary("Submit a new PoDropSquare high score")
            .Produces<PoDropSquareHighScore>(StatusCodes.Status201Created);

        return app;
    }
}
