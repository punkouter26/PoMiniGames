using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Integrity;

namespace PoMiniGames.Features.PoSports;

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
        var sports = app.MapGroup("/posports/highscores").WithTags("HighScores");

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
            async (PoSportsHighScore entry, HttpContext http, IStorageService storage,
                   IScoreIntegrityGuard integrity) =>
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

                // The meet time IS the ranked value, so the guard's check is exact: a meet
                // cannot have taken longer than the session that produced it has existed.
                var verdict = integrity.Inspect(http, GameKey.PoSports, entry.TotalTimeSeconds);
                if (!verdict.Allowed)
                {
                    return verdict.ToProblem();
                }

                // Authoritative identity from the auth cookie — never trust the client.
                var identity = RequestIdentity.Resolve(http.User);
                entry.UserId = identity.UserId;
                entry.IsGuest = identity.IsGuest;
                // PlayerName is the one field here that is still client-chosen and ends up on a
                // page anyone can read without signing in, so it is moderated before storage.
                // The length cap above stays: it rejects early with a clearer message, and the
                // sanitiser's truncation is a silent fallback rather than a contract.
                entry.PlayerName = integrity.ResolveDisplayName(
                    entry.PlayerName,
                    identity.IsGuest ? "Guest" : "Player");

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
