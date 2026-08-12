using PoMiniGames.Application.Services;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Primitives;

namespace PoMiniGames.Features.PoBrawl;

/// <summary>
/// Minimal API endpoints for PoBrawl's three leaderboards: fastest-KO high scores
/// (lower time is better), the presidents ladder, and the demo-mode fighter Elo board.
/// </summary>
/// <remarks>
/// Moved out of <c>Features/HighScores</c> 2026-08-11 so the namespace matches the folder
/// and the slice matches the game — the same correction PoMarbleRace already had. It was
/// also named <c>PoBrawlHighScoresEndpoints</c> while mapping three unrelated boards, only
/// one of which is a high-score table.
/// </remarks>
public static class PoBrawlLeaderboardEndpoints
{
    public static IEndpointRouteBuilder MapPoBrawlLeaderboardEndpoints(this IEndpointRouteBuilder app)
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
                    return Results.BadRequest(new { error = "Player name is required" });

                if (entry.PlayerInitials.Trim().Length > 24)
                    return Results.BadRequest(new { error = "Player name must be 24 characters or fewer" });

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
        // One row per player; ranks by how many of the presidents the player has beaten in
        // 1-player mode (best run ever), Elo as the tiebreaker. The rung ceiling is
        // PoBrawlRoster.Count, never a literal: the client ladder walks PoBrawlRoster.Fighters,
        // so a hardcoded 10 rejected every rung past the tenth once the roster grew to 15 —
        // and because the client discards the submit result, the board silently froze at 10.
        var ladder = app.MapGroup("/api/pobrawl/ladder").WithTags("HighScores");

        // WRITE ONLY, and deliberately so. There is no GET here because the ladder
        // standings are already served by the unified board:
        // UnifiedLeaderboardEndpoints.BuildPoBrawlAsync reads the same PoBrawlLadder
        // table through IStorageService and exposes it at /api/leaderboards/pobrawl,
        // which the /leaderboards page renders. A dedicated GET here existed for months
        // with no caller in the client at all; it was removed 2026-08-11. If you need to
        // read the ladder, use the unified route — do not add a second one.
        //
        // The 1P end-of-match modal no longer shows this board: it moved to the
        // fastest-KO view at /api/leaderboards/pobrawlko (BuildPoBrawlKoAsync), which
        // ranks the GET above's data rather than the ladder's.
        ladder.MapPost("",
            async (PoBrawlLadderEntry entry, IStorageService storage) =>
            {
                if (string.IsNullOrWhiteSpace(entry.PlayerName))
                    return Results.BadRequest(new { error = "Player name is required" });

                if (entry.PlayerName.Trim().Length > 24)
                    return Results.BadRequest(new { error = "Player name must be 24 characters or fewer" });

                if (entry.PresidentsBeaten < 0 || entry.PresidentsBeaten > PoBrawlRoster.Count)
                    return Results.BadRequest(new { error = $"Presidents beaten must be between 0 and {PoBrawlRoster.Count}" });

                var saved = await storage.SavePoBrawlLadderAsync(entry);
                return Results.Created("/api/pobrawl/ladder", saved);
            })
            .WithName("SavePoBrawlLadder")
            .WithSummary("Submit a player's presidents-ladder progress")
            .Produces<PoBrawlLadderEntry>(StatusCodes.Status201Created)
            .RequireRateLimiting("highscores");

        // ── Demo-mode fighter Elo ─────────────────────────────────────────
        // Head-to-head ratings for the presidents, accumulated from CPU-vs-CPU demo
        // matches. Rates characters, not players — see PoBrawlFighterRating.
        var elo = app.MapGroup("/api/pobrawl/elo").WithTags("HighScores");

        elo.MapGet("",
            async (IStorageService storage, int count = 10) =>
            {
                var ratings = await storage.GetPoBrawlFighterRatingsAsync(count);
                return Results.Ok(ratings);
            })
            .WithName("GetPoBrawlFighterRatings")
            .WithSummary("Top PoBrawl fighters by head-to-head Elo")
            // §10 leaderboard READS are anonymous, writes are not. This board holds no
            // per-identity data at all — it rates characters — and the demo route renders
            // while AuthGate's background guest sign-in is still in flight, so gating the
            // read would strand an unattended kiosk on "Loading…" until a session appeared.
            .AllowAnonymous()
            // The rate limit is not optional here, it is what AllowAnonymous costs: dropping
            // the group's auth gate removes this GET's only throttle, and the handler drives a
            // Table Storage partition query per request on an F1 plan. Its own read policy
            // rather than "highscores" — see RateLimitingExtensions; sharing the write bucket
            // would let the demo page's board load eat the budget for its own match submit.
            .RequireRateLimiting("leaderboard-read")
            .Produces<IEnumerable<PoBrawlFighterRating>>(StatusCodes.Status200OK);

        elo.MapPost("",
            async (PoBrawlDemoResultRequest request, IStorageService storage) =>
            {
                // The server owns the Elo arithmetic and the roster: the submission names
                // only who fought and who won. Ratings are never accepted from the client,
                // and an id outside the roster is rejected rather than creating a row —
                // the rating partition stays bounded at the roster size.
                if (!PoBrawlRoster.IsRateable(request.WinnerFighterId) ||
                    !PoBrawlRoster.IsRateable(request.LoserFighterId))
                {
                    return Results.BadRequest(new { error = "Both fighters must be on the PoBrawl presidents roster" });
                }

                if (string.Equals(request.WinnerFighterId, request.LoserFighterId, StringComparison.OrdinalIgnoreCase))
                {
                    return Results.BadRequest(new { error = "A fighter cannot fight itself" });
                }

                var updated = await storage.RecordPoBrawlDemoResultAsync(
                    request.WinnerFighterId, request.LoserFighterId, request.IsDraw);
                return Results.Ok(updated);
            })
            .WithName("RecordPoBrawlDemoResult")
            .WithSummary("Record one CPU-vs-CPU demo match and return the re-ranked board")
            .Produces<IEnumerable<PoBrawlFighterRating>>(StatusCodes.Status200OK)
            .ProducesValidationProblem()
            // 10/min is comfortably above the real demo cadence (a match runs tens of
            // seconds), so a 429 here means something other than the kiosk is posting.
            // A dropped match costs the board one sample and nothing else.
            .RequireRateLimiting("highscores");

        return app;
    }
}
