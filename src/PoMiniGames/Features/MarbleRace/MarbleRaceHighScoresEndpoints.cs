using PoMiniGames.Application.Services;
using PoMiniGames.Domain.Models;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Features.HighScores;

/// <summary>Minimal API endpoints for PoMarbleRace high scores (higher score is better).</summary>
public static class MarbleRaceHighScoresEndpoints
{
    public static IEndpointRouteBuilder MapMarbleRaceHighScoresEndpoints(this IEndpointRouteBuilder app)
    {
        // §1 MapGroup() per slice: PoMarbleRace high scores share /api/marblerace/highscores.
        var marble = app.MapGroup("/api/marblerace/highscores").WithTags("HighScores");

        marble.MapGet("",
            async (IStorageService storage, int count = 10) =>
            {
                count = Math.Clamp(count, 1, 50);
                var scores = await storage.GetMarbleRaceHighScoresAsync(count);
                return Results.Ok(scores);
            })
            .WithName("GetMarbleRaceHighScores")
            .WithSummary("Top PoMarbleRace high scores")
            .Produces<IEnumerable<MarbleRaceHighScore>>(StatusCodes.Status200OK);

        marble.MapPost("",
            async (MarbleRaceHighScoreRequest request,
                   HttpContext http,
                   IStorageService storage,
                   ILoggerFactory loggerFactory) =>
            {
                var log = loggerFactory.CreateLogger("MarbleRaceHighScores");

                // Allow-list the one client-supplied value we accept: a score inside the legal
                // range. MarbleRaceScore is the only way to hold one, so nothing downstream has
                // to re-check it.
                if (!MarbleRaceScore.TryCreate(request.BestScore, out var score))
                {
                    MarbleRaceLog.ScoreRejected(log, request.BestScore, MarbleRaceScore.Min, MarbleRaceScore.Max);
                    return Results.ValidationProblem(new Dictionary<string, string[]>
                    {
                        [nameof(request.BestScore)] =
                            [$"Score must be between {MarbleRaceScore.Min:N0} and {MarbleRaceScore.Max:N0}."],
                    });
                }

                // Server-authoritative identity. The request body carries no name at all: a
                // signed-in caller is named by their claims, and everyone else is "Guest". Trusting
                // a body-supplied name let an anonymous caller post under a real player's name and
                // appear on the board as them.
                var identity = RequestIdentity.Resolve(http.User);
                var name = !string.IsNullOrWhiteSpace(identity.DisplayName)
                    ? identity.DisplayName
                    : identity.IsAuthenticated ? "Player" : "Guest";

                var saved = await storage.SaveMarbleRaceHighScoreAsync(new MarbleRaceHighScore
                {
                    PlayerInitials = name,
                    UserId = identity.UserId,
                    IsGuest = identity.IsGuest,
                    BestScore = score,
                    AchievedAtUtc = DateTimeOffset.UtcNow,
                });

                MarbleRaceLog.ScoreSaved(log, identity.UserId, identity.IsGuest, saved.BestScore);
                return Results.Created("/api/marblerace/highscores", saved);
            })
            .WithName("SaveMarbleRaceHighScore")
            .WithSummary("Submit a new PoMarbleRace high score")
            .Produces<MarbleRaceHighScore>(StatusCodes.Status201Created)
            .ProducesValidationProblem()
            .RequireRateLimiting("highscores");

        return app;
    }
}

/// <summary>
/// The wire shape of a score submission. Scoped to this slice, and deliberately narrower than
/// <see cref="MarbleRaceHighScore"/>: identity and timestamp are server-derived, so there is no
/// field for a caller to supply (or forge) them in.
/// </summary>
public sealed record MarbleRaceHighScoreRequest(int BestScore);

/// <summary>
/// Source-generated logging for the score path. This slice previously logged nothing, so a save
/// that threw surfaced only as an unattributed 500 — which is how a leaderboard that rejected
/// every single submission stayed unnoticed.
/// </summary>
internal static partial class MarbleRaceLog
{
    [LoggerMessage(Level = LogLevel.Information,
        Message = "MarbleRace score saved user={UserId} guest={IsGuest} score={Score}")]
    public static partial void ScoreSaved(ILogger logger, string userId, bool isGuest, int score);

    [LoggerMessage(Level = LogLevel.Warning,
        Message = "MarbleRace score rejected: {Score} outside [{Min}, {Max}]")]
    public static partial void ScoreRejected(ILogger logger, int score, int min, int max);
}
