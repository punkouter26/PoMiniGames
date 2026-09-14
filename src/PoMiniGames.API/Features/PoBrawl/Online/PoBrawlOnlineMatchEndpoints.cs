using Microsoft.AspNetCore.Mvc;
using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Domain.Services;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Integrity;
using PoMiniGames.Features.MatchHistory;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// Result ingest for live PoBrawl 1v1. The match service hands each client its
/// own <see cref="PoBrawlMatchResult"/> when the fight ends; this endpoint is
/// what the client POSTs that result to. The server validates identity from
/// the auth cookie, dedupes by MatchId through MatchHistory's idempotency
/// marker, increments both players' Elo, and returns the updated board.
/// </summary>
public static class PoBrawlOnlineMatchEndpoints
{
    public static IEndpointRouteBuilder MapPoBrawlOnlineMatchEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/pobrawl/matches");

        // GET — read the live 1v1 player-Elo board. Anonymous so it can render
        // before AuthGate completes guest sign-in, same posture as the demo
        // fighter Elo board.
        group.MapGet("",
            async (IStorageService storage, int? top, CancellationToken ct) =>
            {
                var limit = Math.Clamp(top ?? 10, 1, 100);
                var rows = await storage.GetPoBrawlPlayerRatingsAsync(limit);
                return Results.Ok(rows);
            })
            .AllowAnonymous()
            .RequireRateLimiting("leaderboard-read");

        // POST — record a finished 1v1 match and increment both players' Elo.
        group.MapPost("",
            async (
                [FromBody] PoBrawlMatchResultDto dto,
                HttpContext http,
                IStorageService storage,
                IScoreIntegrityGuard integrity,
                MatchHistoryRepository matchHistory,
                ILoggerFactory loggerFactory,
                CancellationToken ct) =>
            {
                var errors = new Dictionary<string, string[]>();
                if (string.IsNullOrWhiteSpace(dto.MatchId))
                    errors[nameof(dto.MatchId)] = ["MatchId is required."];
                if (dto.DurationSeconds is <= 0 or > 600)
                    errors[nameof(dto.DurationSeconds)] = ["Match duration must be between 0 and 600 seconds."];
                if (!PoBrawlRoster.IsRateable(dto.OwnerFighter.Id))
                    errors[nameof(dto.OwnerFighter)] = ["OwnerFighter is not a rateable PoBrawl fighter."];
                if (!PoBrawlRoster.IsRateable(dto.OpponentFighter.Id))
                    errors[nameof(dto.OpponentFighter)] = ["OpponentFighter is not a rateable PoBrawl fighter."];
                if (errors.Count > 0)
                {
                    return Results.ValidationProblem(errors);
                }

                // Authoritative identity — never trust the client-supplied owner id
                // or display name. The auth cookie is the only source of truth for
                // who the submitting player actually is.
                var (userId, displayName, isGuest, _) = RequestIdentity.Resolve(http.User);
                if (string.IsNullOrWhiteSpace(userId))
                {
                    return Results.Problem(
                        title: "Sign in required",
                        detail: "Live 1v1 matches require an authenticated identity so Elo can be attributed.",
                        statusCode: StatusCodes.Status401Unauthorized);
                }

                // Reject self-fights — the lobby already refuses them, but a
                // hand-crafted POST is the kind of thing that has to be defended
                // against anyway.
                if (string.Equals(dto.OwnerId, userId, StringComparison.OrdinalIgnoreCase))
                {
                    // The owner IS the authenticated caller — that's fine, owner IS self.
                    // But the opponent cannot be self.
                }
                if (string.IsNullOrWhiteSpace(dto.OpponentDisplayName))
                    errors[nameof(dto.OpponentDisplayName)] = ["OpponentDisplayName is required."];
                if (errors.Count > 0)
                {
                    return Results.ValidationProblem(errors);
                }

                var log = loggerFactory.CreateLogger("PoBrawlOnlineMatches");
                log.LogInformation(
                    "PoBrawl online match POST user={UserId} matchId={MatchId} outcome={Outcome} duration={Duration}s",
                    userId, dto.MatchId, dto.Outcome, dto.DurationSeconds);

                // MatchHistory write first — its idempotency layer dedupes retries
                // by MatchId. A retried POST re-claims the same marker, returns
                // 409 from the SDK, and we exit without re-incrementing Elo.
                await matchHistory.RecordAsync(new MatchRecordRequest(
                    Owner: integrity.ResolveDisplayName(displayName, isGuest ? "Guest" : "Player"),
                    Game: GameKey.PoBrawl.Value,
                    Mode: "multiplayer",
                    OpponentName: dto.OpponentDisplayName,
                    OpponentType: "guest",
                    Outcome: dto.Outcome.ToString().ToLowerInvariant(),
                    OwnerType: isGuest ? "guest" : "microsoft",
                    MatchId: dto.MatchId), ct);

                // Elo increment. Map the owner-relative outcome to the absolute
                // winner/loser pair the accumulator expects. The opponent's
                // principal id is server-stamped into the match-result payload at
                // broadcast time, so both sides can POST a complete record and the
                // zero-sum write lands on the right pair of rows.
                string winnerPid, loserPid, winnerName, loserName;
                bool isDraw;
                switch (dto.Outcome)
                {
                    case PoBrawlOutcome.Win:
                        winnerPid = userId; loserPid = dto.OpponentId;
                        winnerName = displayName; loserName = dto.OpponentDisplayName;
                        isDraw = false;
                        break;
                    case PoBrawlOutcome.Loss:
                        winnerPid = dto.OpponentId; loserPid = userId;
                        winnerName = dto.OpponentDisplayName; loserName = displayName;
                        isDraw = false;
                        break;
                    default: // Draw
                        // The calculator's symmetric draw formula is order-independent
                        // for the rating math, but the side we pass first still wins
                        // ties — so pick the higher-rated (or the first-seen) side
                        // as "winner". The board is unchanged either way: both rows
                        // move by ±half-delta.
                        winnerPid = userId; loserPid = dto.OpponentId;
                        winnerName = displayName; loserName = dto.OpponentDisplayName;
                        isDraw = true;
                        break;
                }

                // Self-fight guard: a hand-crafted payload naming the same
                // principal on both sides is a 400, not a 500.
                if (string.Equals(winnerPid, loserPid, StringComparison.OrdinalIgnoreCase))
                {
                    return Results.BadRequest(new { error = "opponent_is_self" });
                }

                var board = await storage.RecordPoBrawlOnlineMatchAsync(
                    winnerPrincipalId: NormalisePrincipal(winnerPid),
                    loserPrincipalId: NormalisePrincipal(loserPid),
                    winnerDisplayName: winnerName,
                    loserDisplayName: loserName,
                    isDraw: isDraw);
                return Results.Ok(board);
            })
            .RequireAuthorization()
            .RequireRateLimiting("highscores");

        return app;
    }

    /// <summary>
    /// Principal id sanitiser. Matches the lobby's table-row key normalisation
    /// (lowercased + trimmed) so a write at this endpoint lands on the same
    /// partition the lobby-side state machine wrote to.
    /// </summary>
    private static string NormalisePrincipal(string raw) =>
        string.IsNullOrWhiteSpace(raw) ? "anon" : raw.Trim().ToLowerInvariant();
}
