using PoMiniGames.Application.Services;
using PoMiniGames.Domain.Models;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.PoSports;

namespace PoMiniGames.Features.HighScores;

/// <summary>
/// Minimal API endpoints for PoSports meet times (lower combined time is better).
/// Identity is stamped server-side from the auth cookie like PoRacer — the
/// client-supplied UserId/IsGuest are never trusted.
/// </summary>
public static class PoSportsHighScoresEndpoints
{
    public static IEndpointRouteBuilder MapPoSportsHighScoresEndpoints(this IEndpointRouteBuilder app)
    {
        // §1 MapGroup() per slice: PoSports high scores share /api/posports/highscores.
        var sports = app.MapGroup("/api/posports/highscores").WithTags("HighScores");

        sports.MapGet("",
            async (IStorageService storage, int count = 10) =>
            {
                var scores = await storage.GetPoSportsHighScoresAsync(count);
                return Results.Ok(scores);
            })
            .WithName("GetPoSportsHighScores")
            .WithSummary("Top PoSports meet times (sprint + hurdles combined, ascending)")
            .Produces<IEnumerable<PoSportsHighScore>>(StatusCodes.Status200OK);

        sports.MapPost("",
            async (PoSportsHighScore entry, HttpContext http, IStorageService storage) =>
            {
                if (string.IsNullOrWhiteSpace(entry.PlayerName))
                    return Results.BadRequest(new { error = "Player name is required" });

                if (entry.PlayerName.Trim().Length > 24)
                    return Results.BadRequest(new { error = "Player name must be 24 characters or fewer" });

                if (entry.TotalTimeSeconds is <= 0 or >= 600)
                    return Results.BadRequest(new { error = "Meet time must be between 0 and 600 seconds" });

                if (entry.SprintSeconds is <= 0 or >= 300 || entry.HurdlesSeconds is <= 0 or >= 300)
                    return Results.BadRequest(new { error = "Leg times must be between 0 and 300 seconds" });

                // The total is derived data — reject a payload whose legs don't sum to it.
                if (Math.Abs(entry.SprintSeconds + entry.HurdlesSeconds - entry.TotalTimeSeconds) > 0.05)
                    return Results.BadRequest(new { error = "Leg times must sum to the total" });

                if (!PoSportsConstants.Characters.Contains(entry.Character))
                    return Results.BadRequest(new { error = "Unknown character" });

                // Authoritative identity from the auth cookie — never trust the client.
                var identity = RequestIdentity.Resolve(http.User);
                entry.UserId = identity.UserId;
                entry.IsGuest = identity.IsGuest;

                var saved = await storage.SavePoSportsHighScoreAsync(entry);
                return Results.Created("/api/posports/highscores", saved);
            })
            .WithName("SavePoSportsHighScore")
            .WithSummary("Submit a PoSports meet result")
            .Produces<PoSportsHighScore>(StatusCodes.Status201Created)
            .RequireRateLimiting("highscores");

        return app;
    }
}
