using System.Collections.Concurrent;
using Microsoft.AspNetCore.Mvc;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Integrity;
using PoMiniGames.Infrastructure.Services;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoRacer;

/// <summary>
/// High-score surface for PoRacer. Two material changes from the previous
/// static-list shape:
///   * <b>Persistence</b>: scores live in Azure Table Storage via the shared
///     <see cref="StorageService"/> so they survive API restarts.
///   * <b>Server-side identity</b>: <see cref="PlayerDisplayName"/> is
///     overridden with the auth-cookie identity. The client-supplied name is
///     dropped — it can be anything up to 32 chars, but the leaderboard never
///     trusts it.
///   * <b>Cooldown</b>: a per-user cooldown stops score spam. The dedup row
///     key is the deterministic SHA-256 hash of the immutable content fields,
///     so retries collapse onto the same row (see StorageService.SaveHighScoreAsync).
/// </summary>
public static class PoRacerScoreEndpoints
{
    private const int TopLimit = 50;
    private const int SubmitCooldownSeconds = 30;
    private static readonly ConcurrentDictionary<string, DateTimeOffset> _lastSubmitByUser = new();

    public static void MapPoRacerScoreEndpoints(this IEndpointRouteBuilder app)
    {
        var scores = app.MapGroup("/poracer/scores");

        scores.MapGet("", async (int? top, string? track, StorageService storage, CancellationToken ct) =>
        {
            top = Math.Clamp(top ?? 10, 1, TopLimit);
            var rows = await storage.GetPoRacerHighScoresAsync(top.Value, track);
            return Results.Ok(rows.Select(s => new PoRacerScoreDto
            {
                PlayerDisplayName = s.PlayerName,
                TrackId = s.TrackId,
                TotalTimeSeconds = s.TotalTimeSeconds,
                FinalPosition = s.FinalPosition,
                AchievedAtUtc = DateTimeOffset.TryParse(s.Date, out var d) ? d : DateTimeOffset.UtcNow,
                IsGuest = s.IsGuest,
            }));
        });

        scores.MapPost("", async (
            [FromBody] PoRacerScoreDto dto,
            HttpContext http,
            StorageService storage,
            IScoreIntegrityGuard integrity,
            ILoggerFactory loggerFactory,
            CancellationToken ct) =>
        {
            var errors = new Dictionary<string, string[]>();
            if (dto.TotalTimeSeconds is <= 0 or > 3600)
            {
                errors[nameof(dto.TotalTimeSeconds)] = ["Race time must be between 0 and 3600 seconds."];
            }
            if (dto.FinalPosition is < 1 or > 8)
            {
                errors[nameof(dto.FinalPosition)] = ["Final position must be between 1 and 8."];
            }
            if (errors.Count > 0)
            {
                return Results.ValidationProblem(errors);
            }

            // Race time is the ranked value, so the guard compares the claim against the
            // session's own age: a 90-second race cannot come out of a 20-second session.
            var verdict = integrity.Inspect(http, GameKey.PoRacer, dto.TotalTimeSeconds);
            if (!verdict.Allowed)
            {
                return verdict.ToProblem();
            }

            // Authoritative identity from the auth cookie — NEVER trust the client.
            var (userId, displayName, isGuest, _) = RequestIdentity.Resolve(http.User);

            // Cooldown: at most one submission per user per N seconds.
            if (!string.IsNullOrEmpty(userId))
            {
                var now = DateTimeOffset.UtcNow;
                if (_lastSubmitByUser.TryGetValue(userId, out var last) && (now - last).TotalSeconds < SubmitCooldownSeconds)
                {
                    return Results.Problem(
                        title: "Score submission cooldown",
                        detail: $"Please wait {SubmitCooldownSeconds - (int)(now - last).TotalSeconds}s before submitting again.",
                        statusCode: StatusCodes.Status429TooManyRequests);
                }
                _lastSubmitByUser[userId] = now;
            }

            var log = loggerFactory.CreateLogger("PoRacerScores");
            var trackId = string.IsNullOrWhiteSpace(dto.TrackId) ? "circuit" : dto.TrackId.Trim().ToLowerInvariant();
            log.LogInformation("PoRacer score POST user={UserId} guest={Guest} track={Track} t={T}s pos={Pos}",
                userId, isGuest, trackId, dto.TotalTimeSeconds, dto.FinalPosition);

            var saved = await storage.SavePoRacerHighScoreAsync(new PoRacerHighScore
            {
                PlayerName = integrity.ResolveDisplayName(displayName, isGuest ? "Guest" : "Player"),
                UserId = userId,
                TrackId = trackId,
                TotalTimeSeconds = dto.TotalTimeSeconds,
                FinalPosition = dto.FinalPosition,
                Date = (dto.AchievedAtUtc == default ? DateTimeOffset.UtcNow : dto.AchievedAtUtc).ToString("yyyy-MM-ddTHH:mm:ssZ"),
                IsGuest = isGuest,
                GameCode = dto.GameCode ?? "",
            });
            return Results.Created("/api/poracer/scores", new PoRacerScoreDto
            {
                PlayerDisplayName = saved.PlayerName,
                TrackId = saved.TrackId,
                TotalTimeSeconds = saved.TotalTimeSeconds,
                FinalPosition = saved.FinalPosition,
                AchievedAtUtc = DateTimeOffset.TryParse(saved.Date, out var d) ? d : DateTimeOffset.UtcNow,
                IsGuest = saved.IsGuest,
            });
        });
    }
}

internal sealed class PoRacerScoreEntry
{
    public string PlayerDisplayName { get; set; } = "";
    public string UserId { get; set; } = "";
    public double TotalTimeSeconds { get; set; }
    public int FinalPosition { get; set; }
    public DateTimeOffset AchievedAtUtc { get; set; }
    public bool IsGuest { get; set; }
    public string GameCode { get; set; } = "";
}
