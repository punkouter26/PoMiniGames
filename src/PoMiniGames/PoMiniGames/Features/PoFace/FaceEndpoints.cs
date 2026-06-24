using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using PoMiniGames.Features.PoFace.Storage;

namespace PoMiniGames.Features.PoFace;

/// <summary>
/// Minimal-API endpoints for PoFace (facial-expression game). Routes are namespaced
/// under <c>/api/face/*</c> to avoid collision with the rest of PoMiniGames.
/// </summary>
public static class FaceEndpoints
{
    public static IEndpointRouteBuilder MapFaceEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/face").WithTags("PoFace");

        // ── Status (anon; drives the per-game "USING MOCK DATA" banner) ──

        group.MapGet("/status", (IFaceAnalysisService ai, IHostEnvironment env) =>
        {
            return Results.Ok(new
            {
                game = "poface",
                isMockFaceApi = ai.IsMock,
                environment = env.EnvironmentName
            });
        })
        .WithName("Face_Status")
        .AllowAnonymous();

        // ── Sessions ────────────────────────────────────────────────────────

        group.MapPost("/sessions", (HttpContext ctx) =>
        {
            var userId = ctx.User?.FindFirst(ClaimTypes.NameIdentifier)?.Value
                ?? ctx.User?.FindFirst("sub")?.Value
                ?? $"anon-{Guid.NewGuid():N}".Substring(0, 16);
            var session = new GameSession
            {
                UserId = userId,
                Captures = FaceRoundOrder.Order.Select((e, i) => new RoundCapture
                {
                    RoundNumber = i,
                    TargetEmotion = e
                }).ToList()
            };
            return Results.Ok(new
            {
                sessionId = session.SessionId,
                userId = session.UserId,
                rounds = FaceRoundOrder.Order.Select((e, i) => new { roundNumber = i, targetEmotion = e.ToString() }).ToList()
            });
        })
        .RequireAuthorization()
        .WithName("Face_StartSession");

        group.MapPost("/sessions/{id}/rounds/{n}/score", async (
            string id, int n,
            HttpContext ctx,
            IGameSessionRepository sessions,
            IFaceAnalysisService analyzer,
            IBlobImageRepository blob,
            CancellationToken cancellationToken) =>
        {
            var userId = ctx.User?.FindFirst(ClaimTypes.NameIdentifier)?.Value
                ?? ctx.User?.FindFirst("sub")?.Value
                ?? "anon";
            if (n < 0 || n >= FaceRoundOrder.Order.Count)
            {
                return Results.BadRequest(new { error = $"Invalid round number {n}; must be 0..{FaceRoundOrder.Order.Count - 1}" });
            }

            // Read image bytes from the multipart form (if any) or the raw request body.
            byte[]? imageJpeg = null;
            if (ctx.Request.HasFormContentType)
            {
                var form = await ctx.Request.ReadFormAsync(cancellationToken);
                var file = form.Files["image"];
                if (file is null || file.Length == 0)
                {
                    return Results.BadRequest(new { error = "Missing 'image' file in multipart form" });
                }
                if (file.Length > 500 * 1024)
                {
                    return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
                }
                using var ms = new MemoryStream();
                await file.CopyToAsync(ms, cancellationToken);
                imageJpeg = ms.ToArray();
            }
            else
            {
                if (ctx.Request.ContentLength is null or > 500 * 1024)
                {
                    return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
                }
                using var ms = new MemoryStream();
                await ctx.Request.Body.CopyToAsync(ms, cancellationToken);
                imageJpeg = ms.ToArray();
            }

            var session = await sessions.GetAsync(userId, id, cancellationToken) ?? new GameSession
            {
                SessionId = id, UserId = userId,
                Captures = FaceRoundOrder.Order.Select((e, i) => new RoundCapture { RoundNumber = i, TargetEmotion = e }).ToList()
            };
            if (session.UserId != userId)
            {
                return Results.StatusCode(StatusCodes.Status403Forbidden);
            }
            if (session.IsComplete)
            {
                return Results.BadRequest(new { error = "Session is already complete" });
            }

            var target = FaceRoundOrder.Order[n];
            var analysis = await analyzer.AnalyzeAsync(imageJpeg!, target, cancellationToken);
            var headPoseValid = HeadPoseValidator.Validate(analysis.Yaw, analysis.Pitch);
            var score = headPoseValid ? (int)Math.Round(analysis.TargetEmotionConfidence * 10) : 0;

            // Replace the matching round capture.
            var capture = session.Captures.FirstOrDefault(c => c.RoundNumber == n);
            if (capture is null)
            {
                return Results.BadRequest(new { error = $"Round {n} not in session" });
            }
            capture.TargetEmotionConfidence = analysis.TargetEmotionConfidence;
            capture.Yaw = analysis.Yaw;
            capture.Pitch = analysis.Pitch;
            capture.Roll = analysis.Roll;
            capture.HeadPoseValid = headPoseValid;
            capture.Score = score;
            capture.CapturedAt = DateTime.UtcNow;

            // Best-effort blob upload for the recap page.
            var blobUri = await blob.UploadAsync(userId, id, n, imageJpeg!, cancellationToken);
            capture.ImageUrl = blobUri;

            await sessions.SaveAsync(session, cancellationToken);

            return Results.Ok(new
            {
                sessionId = session.SessionId,
                roundNumber = n,
                targetEmotion = target.ToString(),
                faceDetected = analysis.FaceDetected,
                confidence = analysis.TargetEmotionConfidence,
                headPoseValid,
                score,
                totalScore = session.TotalScore,
                imageUrl = blobUri
            });
        })
        .RequireAuthorization()
        .RequireRateLimiting("face-analysis")
        .WithName("Face_ScoreRound");

        group.MapPost("/sessions/{id}/complete", async (
            string id, HttpContext ctx,
            IGameSessionRepository sessions,
            ILeaderboardRepository leaderboard,
            IPlayerStatsRepository playerStats,
            CancellationToken cancellationToken) =>
        {
            var userId = ctx.User?.FindFirst(ClaimTypes.NameIdentifier)?.Value
                ?? ctx.User?.FindFirst("sub")?.Value
                ?? "anon";
            var session = await sessions.GetAsync(userId, id, cancellationToken);
            if (session is null) return Results.NotFound();
            if (session.UserId != userId) return Results.StatusCode(StatusCodes.Status403Forbidden);
            // Idempotency: a duplicate/retried complete must not double-count leaderboard
            // and player-stat aggregates. Return the already-finalised result instead.
            if (session.IsComplete)
            {
                return Results.Ok(new
                {
                    sessionId = session.SessionId,
                    totalScore = session.TotalScore,
                    perRound = session.Captures.Select(c => new { round = c.RoundNumber, emotion = c.TargetEmotion.ToString(), score = c.Score }).ToList(),
                    alreadyComplete = true
                });
            }
            if (session.Captures.Count(c => c.CapturedAt > DateTime.MinValue) < FaceRoundOrder.Order.Count)
            {
                return Results.UnprocessableEntity(new { error = "All 5 rounds must be captured before completing" });
            }
            session.IsComplete = true;
            session.ExpiresAt = DateTime.UtcNow.AddDays(365); // personal-best sessions are kept
            await sessions.SaveAsync(session, cancellationToken);

            await leaderboard.UpsertBestAsync(new LeaderboardEntry
            {
                UserId = userId,
                Score = session.TotalScore,
                Year = DateTime.UtcNow.Year
            }, cancellationToken);

            var stats = await playerStats.GetAsync(userId, cancellationToken) ?? new PlayerStats { UserId = userId };
            stats.RecordCompletedSession(session);
            await playerStats.SaveAsync(stats, cancellationToken);

            return Results.Ok(new
            {
                sessionId = session.SessionId,
                totalScore = session.TotalScore,
                perRound = session.Captures.Select(c => new { round = c.RoundNumber, emotion = c.TargetEmotion.ToString(), score = c.Score }).ToList()
            });
        })
        .RequireAuthorization()
        .WithName("Face_CompleteSession");

        // ── Leaderboard ────────────────────────────────────────────────────

        group.MapGet("/leaderboard", async (
            [FromQuery] int? top, [FromQuery] int? year,
            ILeaderboardRepository repo,
            CancellationToken cancellationToken) =>
        {
            var y = year ?? DateTime.UtcNow.Year;
            var entries = await repo.GetTopAsync(y, top ?? 100, cancellationToken);
            return Results.Ok(entries);
        })
        .WithName("Face_GetLeaderboard")
        .RequireAuthorization();

        // ── Per-player stats ───────────────────────────────────────────────

        group.MapGet("/stats/me", async (
            HttpContext ctx, IPlayerStatsRepository repo, CancellationToken cancellationToken) =>
        {
            var userId = ctx.User?.FindFirst(ClaimTypes.NameIdentifier)?.Value
                ?? ctx.User?.FindFirst("sub")?.Value;
            if (string.IsNullOrEmpty(userId)) return Results.Unauthorized();
            var stats = await repo.GetAsync(userId, cancellationToken);
            return stats is null ? Results.Ok(new PlayerStats { UserId = userId }) : Results.Ok(stats);
        })
        .WithName("Face_GetMyStats")
        .RequireAuthorization();

        return app;
    }
}
