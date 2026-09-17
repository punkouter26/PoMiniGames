using Microsoft.AspNetCore.Mvc;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Integrity;
using PoMiniGames.Infrastructure.Services;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoRacer;

/// <summary>Authenticated best-lap submission; reads use the unified leaderboard.</summary>
public static class PoRacerScoreEndpoints
{
    public static void MapPoRacerScoreEndpoints(this IEndpointRouteBuilder app)
    {
        var scores = app.MapGroup("/poracer/scores");

        scores.MapPost("", async (
            [FromBody] PoRacerScoreDto dto,
            HttpContext http,
            StorageService storage,
            IScoreIntegrityGuard integrity,
            ILoggerFactory loggerFactory) =>
        {
            var errors = new Dictionary<string, string[]>();
            if (!double.IsFinite(dto.BestLapSeconds) || dto.BestLapSeconds is <= 0 or > 3600)
            {
                errors[nameof(dto.BestLapSeconds)] = ["Best lap must be between 0 and 3600 seconds."];
            }
            if (dto.FinalPosition is < 1 or > 8)
            {
                errors[nameof(dto.FinalPosition)] = ["Final position must be between 1 and 8."];
            }
            if (!PoRacerCatalog.Tracks.Any(t => t.Id == dto.TrackId))
                errors[nameof(dto.TrackId)] = ["Choose a supported track."];
            if (errors.Count > 0)
            {
                return Results.ValidationProblem(errors);
            }

            // A best lap cannot be longer than the play session that produced it.
            var verdict = integrity.Inspect(http, GameKey.PoRacer, dto.BestLapSeconds);
            if (!verdict.Allowed)
            {
                return verdict.ToProblem();
            }

            // Authoritative identity from the auth cookie — NEVER trust the client.
            var (userId, displayName, isGuest, _) = RequestIdentity.Resolve(http.User);

            var log = loggerFactory.CreateLogger("PoRacerScores");
            var trackId = string.IsNullOrWhiteSpace(dto.TrackId) ? "circuit" : dto.TrackId.Trim().ToLowerInvariant();
            log.LogInformation("PoRacer score POST user={UserId} guest={Guest} track={Track} t={T}s pos={Pos}",
                userId, isGuest, trackId, dto.BestLapSeconds, dto.FinalPosition);

            PoRacerHighScore saved;
            try
            {
                saved = await storage.SavePoRacerHighScoreAsync(new PoRacerHighScore
            {
                PlayerName = integrity.ResolveDisplayName(displayName, isGuest ? "Guest" : "Player"),
                UserId = userId,
                TrackId = trackId,
                TotalTimeSeconds = dto.BestLapSeconds,
                FinalPosition = dto.FinalPosition,
                Date = (dto.AchievedAtUtc == default ? DateTimeOffset.UtcNow : dto.AchievedAtUtc).ToString("yyyy-MM-ddTHH:mm:ssZ"),
                IsGuest = isGuest,
                GameCode = dto.GameCode ?? "",
            });
            }
            catch (IOException)
            {
                return Results.Problem("Best lap could not be stored. Please retry.", statusCode: StatusCodes.Status503ServiceUnavailable);
            }
            return Results.Created("/api/poracer/scores", new PoRacerScoreDto
            {
                PlayerDisplayName = saved.PlayerName,
                UserId = saved.UserId,
                TrackId = saved.TrackId,
                BestLapSeconds = saved.TotalTimeSeconds,
                FinalPosition = saved.FinalPosition,
                AchievedAtUtc = DateTimeOffset.TryParse(saved.Date, out var d) ? d : DateTimeOffset.UtcNow,
                IsGuest = saved.IsGuest,
            });
        });
    }
}
