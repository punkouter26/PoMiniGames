using PoMiniGames.Application.Services;
using PoMiniGames.Domain.Models;

namespace PoMiniGames.Features.HighScores;

/// <summary>Minimal API endpoints for PoMarbleRace high scores (higher score is better).</summary>
public static class MarbleRaceHighScoresEndpoints
{
    public static IEndpointRouteBuilder MapMarbleRaceHighScoresEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/marblerace/highscores",
            async (IStorageService storage, int count = 10) =>
            {
                var scores = await storage.GetMarbleRaceHighScoresAsync(count);
                return Results.Ok(scores);
            })
            .WithName("GetMarbleRaceHighScores")
            .WithTags("HighScores")
            .WithSummary("Top PoMarbleRace high scores")
            .Produces<IEnumerable<MarbleRaceHighScore>>(StatusCodes.Status200OK);

        app.MapPost("/api/marblerace/highscores",
            async (MarbleRaceHighScore entry, IStorageService storage) =>
            {
                if (string.IsNullOrWhiteSpace(entry.PlayerInitials))
                    return Results.BadRequest(new { error = "Initials are required" });

                if (entry.PlayerInitials.Trim().Length > 3)
                    return Results.BadRequest(new { error = "Initials must be 3 characters or fewer" });

                if (entry.BestScore < 0)
                    return Results.BadRequest(new { error = "Score must be non-negative" });

                var saved = await storage.SaveMarbleRaceHighScoreAsync(entry);
                return Results.Created("/api/marblerace/highscores", saved);
            })
            .WithName("SaveMarbleRaceHighScore")
            .WithTags("HighScores")
            .WithSummary("Submit a new PoMarbleRace high score")
            .Produces<MarbleRaceHighScore>(StatusCodes.Status201Created)
            .RequireRateLimiting("highscores");

        return app;
    }
}
