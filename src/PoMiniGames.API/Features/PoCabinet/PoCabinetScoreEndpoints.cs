using Microsoft.AspNetCore.Mvc;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Integrity;
using PoMiniGames.Infrastructure.Services;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// PoCabinet score endpoints. Anonymous reads (per-track leaderboards);
/// authenticated best-lap submissions guarded by the <c>pocabinet</c> rate-limit
/// policy (added 2026-09-17 alongside this slice).
/// </summary>
public static class PoCabinetScoreEndpoints
{
    public static void MapPoCabinetScoreEndpoints(this IEndpointRouteBuilder app)
    {
        // Mounted under gameApi (which has the /api prefix) — paths below are RELATIVE.
        // Anonymous reads — bounded by leaderboard-read (60/min). RequireAuthorization is
        // skipped here because gameApi has it; an anonymous read on /api/{game}/scores
        // would otherwise 401, which the §10 contract says it must not.
        app.MapGet("/pocabinet/scores", GetScoresAsync)
            .AllowAnonymous()
            .RequireRateLimiting("leaderboard-read");

        // Authenticated writes — bounded by pocabinet (10/min, same shape as highscores).
        app.MapPost("/pocabinet/scores", PostScoreAsync)
            .RequireRateLimiting("pocabinet");
    }

    private static async Task<IResult> GetScoresAsync(
        [FromQuery(Name = "track")] string? track,
        StorageService storage,
        CancellationToken ct)
    {
        var resolved = ResolveTrack(track);
        var rows = await storage.GetPoCabinetHighScoresAsync(limit: 10, trackId: resolved);
        return Results.Ok(rows);
    }

    private static async Task<IResult> PostScoreAsync(
        [FromBody] PoCabinetScoreDto dto,
        HttpContext http,
        StorageService storage,
        IScoreIntegrityGuard integrity,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        var errors = new Dictionary<string, string[]>();
        if (!double.IsFinite(dto.BestLapSeconds) || dto.BestLapSeconds is <= 0 or > 3600)
            errors[nameof(dto.BestLapSeconds)] = ["Best lap must be between 0 and 3600 seconds."];
        if (dto.FinalPosition is < 1 or > 9)
            errors[nameof(dto.FinalPosition)] = ["Final position must be between 1 and 9."];
        if (!PoCabinetCatalog.IsKnownTrack(dto.TrackId))
            errors[nameof(dto.TrackId)] = ["Choose a supported track."];
        if (errors.Count > 0)
            return Results.ValidationProblem(errors);

        var verdict = integrity.Inspect(http, GameKey.PoCabinet, dto.BestLapSeconds);
        if (!verdict.Allowed) return verdict.ToProblem();

        var (userId, displayName, isGuest, _) = RequestIdentity.Resolve(http.User);
        var log = loggerFactory.CreateLogger("PoCabinetScores");
        var trackId = ResolveTrack(dto.TrackId);

        log.LogInformation(
            "PoCabinet score POST user={UserId} guest={Guest} track={Track} t={T}s pos={Pos}",
            userId, isGuest, trackId, dto.BestLapSeconds, dto.FinalPosition);

        PoCabinetHighScore saved;
        try
        {
            saved = await storage.SavePoCabinetHighScoreAsync(new PoCabinetHighScore
            {
                PlayerName = integrity.ResolveDisplayName(displayName, isGuest ? "Guest" : "Player"),
                UserId = userId,
                TrackId = trackId,
                BestLapSeconds = dto.BestLapSeconds,
                FinalPosition = dto.FinalPosition,
                IsGuest = isGuest,
                Date = (dto.AchievedAtUtc == default ? DateTimeOffset.UtcNow : dto.AchievedAtUtc)
                    .ToString("yyyy-MM-ddTHH:mm:ssZ"),
                GameCode = dto.GameCode ?? "",
            });
        }
        catch (IOException)
        {
            return Results.Problem(
                "Best lap could not be stored. Please retry.",
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }

        return Results.Created("/api/pocabinet/scores", new PoCabinetScoreDto
        {
            PlayerDisplayName = saved.PlayerName,
            UserId = saved.UserId,
            TrackId = saved.TrackId,
            BestLapSeconds = saved.BestLapSeconds,
            FinalPosition = saved.FinalPosition,
            AchievedAtUtc = DateTimeOffset.TryParse(saved.Date, out var d) ? d : DateTimeOffset.UtcNow,
            IsGuest = saved.IsGuest,
            GameCode = saved.GameCode,
        });
    }

    /// <summary>Normalise unknown / null / casing to the canonical default track id.</summary>
    private static string ResolveTrack(string? track)
    {
        if (string.IsNullOrWhiteSpace(track)) return PoCabinetCatalog.DefaultTrackId;
        var trimmed = track.Trim().ToLowerInvariant();
        return PoCabinetCatalog.IsKnownTrack(trimmed) ? trimmed : PoCabinetCatalog.DefaultTrackId;
    }
}

/// <summary>
/// Inbound score payload from the client. <see cref="TrackId"/> accepts any
/// casing; the server normalises to the canonical lower-case id before saving.
/// </summary>
public sealed class PoCabinetScoreDto
{
    public string PlayerDisplayName { get; set; } = "";
    /// <summary>Server-populated from auth cookie. Empty/zero on submit → server fills.</summary>
    public string UserId { get; set; } = "";
    public string TrackId { get; set; } = "capitol";
    public double BestLapSeconds { get; set; }
    public int FinalPosition { get; set; }
    public DateTimeOffset AchievedAtUtc { get; set; }
    public bool IsGuest { get; set; }
    public string GameCode { get; set; } = "";
}
