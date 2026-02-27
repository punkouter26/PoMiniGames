using PoMiniGames.Models;
using PoMiniGames.Services;

namespace PoMiniGames.Features.SnakeHighScores;

/// <summary>Return the top PoSnakeGame high scores.</summary>
public static class GetSnakeHighScoresEndpoint
{
    public static IEndpointRouteBuilder MapGetSnakeHighScores(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/snake/highscores",
            async (StorageService storage, int count = 10) =>
            {
                var scores = await storage.GetSnakeHighScoresAsync(count);
                return Results.Ok(scores);
            })
            .WithName("GetSnakeHighScores")
            .WithTags("SnakeHighScores")
            .WithSummary("Top PoSnakeGame high scores")
            .Produces<IEnumerable<SnakeHighScore>>(StatusCodes.Status200OK);

        return app;
    }
}
