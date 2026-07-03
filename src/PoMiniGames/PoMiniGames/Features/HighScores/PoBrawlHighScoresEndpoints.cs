using PoMiniGames.Application.Services;
using PoMiniGames.Domain.Models;

namespace PoMiniGames.Features.HighScores;

/// <summary>Minimal API endpoints for PoBrawl fastest-KO high scores (lower time is better).</summary>
public static class PoBrawlHighScoresEndpoints
{
    public static IEndpointRouteBuilder MapPoBrawlHighScoresEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/pobrawl/highscores",
            async (IStorageService storage, int count = 10) =>
            {
                var scores = await storage.GetPoBrawlHighScoresAsync(count);
                return Results.Ok(scores);
            })
            .WithName("GetPoBrawlHighScores")
            .WithTags("HighScores")
            .WithSummary("Top PoBrawl fastest-KO times")
            .Produces<IEnumerable<PoBrawlHighScore>>(StatusCodes.Status200OK);

        app.MapPost("/api/pobrawl/highscores",
            async (PoBrawlHighScore entry, IStorageService storage) =>
            {
                if (string.IsNullOrWhiteSpace(entry.PlayerInitials))
                    return Results.BadRequest(new { error = "Initials are required" });

                if (entry.PlayerInitials.Trim().Length > 3)
                    return Results.BadRequest(new { error = "Initials must be 3 characters or fewer" });

                if (entry.KoTimeSeconds <= 0 || entry.KoTimeSeconds >= 600)
                    return Results.BadRequest(new { error = "KO time must be between 0 and 600 seconds" });

                var saved = await storage.SavePoBrawlHighScoreAsync(entry);
                return Results.Created("/api/pobrawl/highscores", saved);
            })
            .WithName("SavePoBrawlHighScore")
            .WithTags("HighScores")
            .WithSummary("Submit a new PoBrawl fastest-KO time")
            .Produces<PoBrawlHighScore>(StatusCodes.Status201Created)
            .RequireRateLimiting("highscores");

        return app;
    }
}
