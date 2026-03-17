using PoMiniGames.Models;
using PoMiniGames.Services;

namespace PoMiniGames.Features.PoDropSquareHighScores;

/// <summary>Return the top PoDropSquare high scores ranked by survival time.</summary>
public static class GetPoDropSquareHighScoresEndpoint
{
    public static IEndpointRouteBuilder MapGetPoDropSquareHighScores(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/podropsquare/highscores",
            async (IStorageService storage, int count = 10) =>
            {
                var scores = await storage.GetPoDropSquareHighScoresAsync(count);
                return Results.Ok(scores);
            })
            .WithName("GetPoDropSquareHighScores")
            .WithTags("PoDropSquareHighScores")
            .WithSummary("Top PoDropSquare high scores ranked by lowest survival time")
            .Produces<IEnumerable<PoDropSquareHighScore>>(StatusCodes.Status200OK);

        return app;
    }
}
