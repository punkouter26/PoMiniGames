using PoMiniGames.Application.Services;
using PoMiniGames.Domain.Models;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Features.HighScores;

/// <summary>Minimal API endpoints for PoMarbleRace high scores (higher score is better).</summary>
public static class MarbleRaceHighScoresEndpoints
{
    // Sanity ceiling: a real PoMarbleRace run tops out well under this. It exists only to
    // reject a tampered submission (e.g. int.MaxValue) that would permanently own the board,
    // not to bound legitimate play.
    private const int MaxRealisticScore = 1_000_000;

    public static IEndpointRouteBuilder MapMarbleRaceHighScoresEndpoints(this IEndpointRouteBuilder app)
    {
        // §1 MapGroup() per slice: PoMarbleRace high scores share /api/marblerace/highscores.
        var marble = app.MapGroup("/api/marblerace/highscores").WithTags("HighScores");

        marble.MapGet("",
            async (IStorageService storage, int count = 10) =>
            {
                var scores = await storage.GetMarbleRaceHighScoresAsync(count);
                return Results.Ok(scores);
            })
            .WithName("GetMarbleRaceHighScores")
            .WithSummary("Top PoMarbleRace high scores")
            .Produces<IEnumerable<MarbleRaceHighScore>>(StatusCodes.Status200OK);

        marble.MapPost("",
            async (MarbleRaceHighScore entry, HttpContext http, IStorageService storage) =>
            {
                if (entry.BestScore < 0)
                    return Results.BadRequest(new { error = "Score must be non-negative" });
                if (entry.BestScore > MaxRealisticScore)
                    return Results.BadRequest(new { error = $"Score exceeds the maximum of {MaxRealisticScore:N0}" });

                // Server-authoritative identity: a signed-in caller can only post under their
                // own name — the client-supplied initials are ignored so nobody can overwrite
                // another player's board entry. Guests keep their supplied (sanitized) name.
                var identity = RequestIdentity.Resolve(http.User);
                var name = identity.IsAuthenticated && !string.IsNullOrWhiteSpace(identity.DisplayName)
                    ? identity.DisplayName
                    : entry.PlayerInitials;

                if (string.IsNullOrWhiteSpace(name))
                    return Results.BadRequest(new { error = "Player name is required" });
                if (name.Trim().Length > 24)
                    name = name.Trim()[..24];

                var saved = await storage.SaveMarbleRaceHighScoreAsync(entry with { PlayerInitials = name });
                return Results.Created("/api/marblerace/highscores", saved);
            })
            .WithName("SaveMarbleRaceHighScore")
            .WithSummary("Submit a new PoMarbleRace high score")
            .Produces<MarbleRaceHighScore>(StatusCodes.Status201Created)
            .RequireRateLimiting("highscores");

        return app;
    }
}
