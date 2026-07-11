using PoMiniGames.Application.Services;
using PoMiniGames.Domain.Models;

namespace PoMiniGames.Features.HighScores;

/// <summary>Minimal API endpoints for PoBrawl fastest-KO high scores (lower time is better).</summary>
public static class PoBrawlHighScoresEndpoints
{
    public static IEndpointRouteBuilder MapPoBrawlHighScoresEndpoints(this IEndpointRouteBuilder app)
    {
        // §1 MapGroup() per slice: PoBrawl high scores share /api/pobrawl/highscores.
        var brawl = app.MapGroup("/api/pobrawl/highscores").WithTags("HighScores");

        brawl.MapGet("",
            async (IStorageService storage, int count = 10) =>
            {
                var scores = await storage.GetPoBrawlHighScoresAsync(count);
                return Results.Ok(scores);
            })
            .WithName("GetPoBrawlHighScores")
            .WithSummary("Top PoBrawl fastest-KO times")
            .Produces<IEnumerable<PoBrawlHighScore>>(StatusCodes.Status200OK);

        brawl.MapPost("",
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
            .WithSummary("Submit a new PoBrawl fastest-KO time")
            .Produces<PoBrawlHighScore>(StatusCodes.Status201Created)
            .RequireRateLimiting("highscores");

        // ── Presidents-ladder leaderboard ─────────────────────────────────
        // One row per player; ranks by how many of the 10 presidents the player
        // has beaten in 1-player mode (best run ever), Elo as the tiebreaker.
        var ladder = app.MapGroup("/api/pobrawl/ladder").WithTags("HighScores");

        ladder.MapGet("",
            async (IStorageService storage, int count = 10) =>
            {
                var entries = await storage.GetPoBrawlLadderAsync(count);
                return Results.Ok(entries);
            })
            .WithName("GetPoBrawlLadder")
            .WithSummary("Top PoBrawl ladder runs (presidents beaten out of 10)")
            .Produces<IEnumerable<PoBrawlLadderEntry>>(StatusCodes.Status200OK);

        ladder.MapPost("",
            async (PoBrawlLadderEntry entry, IStorageService storage) =>
            {
                if (string.IsNullOrWhiteSpace(entry.PlayerName))
                    return Results.BadRequest(new { error = "Player name is required" });

                if (entry.PlayerName.Trim().Length > 24)
                    return Results.BadRequest(new { error = "Player name must be 24 characters or fewer" });

                if (entry.PresidentsBeaten is < 0 or > 10)
                    return Results.BadRequest(new { error = "Presidents beaten must be between 0 and 10" });

                var saved = await storage.SavePoBrawlLadderAsync(entry);
                return Results.Created("/api/pobrawl/ladder", saved);
            })
            .WithName("SavePoBrawlLadder")
            .WithSummary("Submit a player's presidents-ladder progress")
            .Produces<PoBrawlLadderEntry>(StatusCodes.Status201Created)
            .RequireRateLimiting("highscores");

        return app;
    }
}
