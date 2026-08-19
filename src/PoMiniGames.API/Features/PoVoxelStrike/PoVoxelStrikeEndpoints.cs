using System.Text.RegularExpressions;
using PoMiniGames.Application.Services;
using PoMiniGames.Domain.Models;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Features.PoVoxelStrike;

/// <summary>
/// Read-only asset delivery for PoVoxelStrike (PRD §F2). Mapped in the anonymous section
/// of <c>MapPoMiniGamesEndpoints</c>: assets are game content, and the platform contract
/// is anonymous reads / authenticated writes — the M4 run-submission POST will join the
/// authenticated <c>gameApi</c> group instead.
/// </summary>
internal static class PoVoxelStrikeEndpoints
{
    public static IEndpointRouteBuilder MapPoVoxelStrikeAssetEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/povoxelstrike").WithTags("PoVoxelStrike");

        group.MapGet("/assets", (VoxelAssetCatalog catalog) =>
                Results.Ok(catalog.All.Select(a => new VoxelAssetManifestEntry(
                    a.Hash, a.Name, [a.DimX, a.DimY, a.DimZ], a.SizeBytes,
                    $"api/povoxelstrike/assets/{a.Hash}"))))
            .WithName("GetPoVoxelStrikeAssetManifest")
            .WithSummary("Lists every converted voxel asset (grows while startup ingestion is still running).")
            .Produces<IEnumerable<VoxelAssetManifestEntry>>(StatusCodes.Status200OK)
            .RequireRateLimiting("leaderboard-read");

        group.MapGet("/assets/{hash}", (string hash, HttpContext http, VoxelAssetCatalog catalog) =>
            {
                if (!catalog.TryGet(hash, out var asset))
                {
                    return Results.Problem(
                        title: "Unknown asset",
                        detail: "No converted voxel asset has this content hash.",
                        statusCode: StatusCodes.Status404NotFound);
                }

                // Content-addressed → immutable forever: a changed GLB is a new hash, so the
                // client Cache API layer and the browser never need to revalidate this URL.
                var etag = $"\"{hash}\"";
                http.Response.Headers.CacheControl = "public, max-age=31536000, immutable";
                http.Response.Headers.ETag = etag;
                if (http.Request.Headers.IfNoneMatch.Any(v => v == etag || v == "*"))
                {
                    return Results.StatusCode(StatusCodes.Status304NotModified);
                }
                return Results.File(asset.PayloadPath, "application/octet-stream");
            })
            .AddEndpointFilter<PvxHashEndpointFilter>()
            .WithName("GetPoVoxelStrikeAssetPayload")
            .WithSummary("Streams one converted .pvx voxel volume by content hash.")
            .Produces(StatusCodes.Status200OK, contentType: "application/octet-stream")
            .ProducesValidationProblem()
            .ProducesProblem(StatusCodes.Status404NotFound)
            .RequireRateLimiting("leaderboard-read");

        return app;
    }

    /// <summary>
    /// Run submissions + the slice's own board read. Mapped inside the authenticated
    /// <c>gameApi</c> group (the anonymous read surface is the unified
    /// <c>/api/leaderboards/povoxelstrike</c>), mirroring the PoSports/Marble slices.
    /// </summary>
    public static IEndpointRouteBuilder MapPoVoxelStrikeScoreEndpoints(this IEndpointRouteBuilder app)
    {
        var scores = app.MapGroup("/api/povoxelstrike/highscores").WithTags("HighScores");

        scores.MapGet("",
            async (IStorageService storage, int count = 10) =>
            {
                count = Math.Clamp(count, 1, 100);
                return Results.Ok(await storage.GetPoVoxelStrikeHighScoresAsync(count));
            })
            .WithName("GetPoVoxelStrikeHighScores")
            .WithSummary("Top PoVoxelStrike runs (one ratcheted row per player)")
            .Produces<IEnumerable<PoVoxelStrikeHighScore>>(StatusCodes.Status200OK);

        scores.MapPost("",
            async (PoVoxelStrikeRunRequest request,
                   HttpContext http,
                   IStorageService storage,
                   ILoggerFactory loggerFactory) =>
            {
                var log = loggerFactory.CreateLogger("PoVoxelStrikeHighScores");

                if (!PoVoxelStrikeScore.TryCreate(request.Score, out var score))
                {
                    PoVoxelStrikeLog.ScoreRejected(log, request.Score, "outside legal range");
                    return Results.ValidationProblem(new Dictionary<string, string[]>
                    {
                        [nameof(request.Score)] =
                            [$"Score must be between {PoVoxelStrikeScore.Min:N0} and {PoVoxelStrikeScore.Max:N0}."],
                    });
                }

                // Plausibility, not anti-cheat (PRD §3.3): the stats must be able to produce
                // the score. Formula ceiling: seconds×10 + kills×(25+50+40 worst case) +
                // voxels÷20, plus rounding slack. A submission that exceeds its own stats'
                // ceiling is tampered or corrupt either way — rejecting is not a retry case.
                var errors = new Dictionary<string, string[]>();
                if (request.SurvivalSeconds is < 0 or > 14_400)
                    errors[nameof(request.SurvivalSeconds)] = ["Survival time must be between 0 and 14,400 seconds."];
                if (request.Kills < 0 || request.BruteKills < 0 || request.CrushKills < 0 || request.VoxelsDestroyed < 0)
                    errors[nameof(request.Kills)] = ["Run stats cannot be negative."];
                if (request.BruteKills > request.Kills || request.CrushKills > request.Kills)
                    errors[nameof(request.BruteKills)] = ["Kill breakdowns cannot exceed total kills."];
                var ceiling = Math.Floor(request.SurvivalSeconds + 1) * 10
                    + (double)request.Kills * 115 + request.VoxelsDestroyed / 20d + 10;
                if (errors.Count == 0 && request.Score > ceiling)
                    errors[nameof(request.Score)] = ["Score is not plausible for the submitted run stats."];
                if (errors.Count > 0)
                {
                    PoVoxelStrikeLog.ScoreRejected(log, request.Score, string.Join("; ", errors.Values.SelectMany(v => v)));
                    return Results.ValidationProblem(errors);
                }

                // Server-authoritative identity — the body carries no name to forge.
                var identity = RequestIdentity.Resolve(http.User);
                var name = !string.IsNullOrWhiteSpace(identity.DisplayName)
                    ? identity.DisplayName
                    : identity.IsAuthenticated ? "Player" : "Guest";

                var saved = await storage.SavePoVoxelStrikeHighScoreAsync(new PoVoxelStrikeHighScore
                {
                    PlayerName = name,
                    UserId = identity.UserId,
                    IsGuest = identity.IsGuest,
                    Score = score,
                    SurvivalSeconds = request.SurvivalSeconds,
                    Kills = request.Kills,
                    BruteKills = request.BruteKills,
                    CrushKills = request.CrushKills,
                    VoxelsDestroyed = request.VoxelsDestroyed,
                    AchievedAtUtc = DateTimeOffset.UtcNow,
                });

                PoVoxelStrikeLog.ScoreSaved(log, identity.UserId, identity.IsGuest, saved.Score);
                return Results.Created("/api/povoxelstrike/highscores", saved);
            })
            .WithName("SavePoVoxelStrikeHighScore")
            .WithSummary("Submit a finished PoVoxelStrike run")
            .Produces<PoVoxelStrikeHighScore>(StatusCodes.Status201Created)
            .ProducesValidationProblem()
            .RequireRateLimiting("highscores");

        return app;
    }
}

/// <summary>
/// The wire shape of a run submission. Deliberately narrower than
/// <see cref="PoVoxelStrikeHighScore"/>: identity and timestamp are server-derived, so
/// there is no field for a caller to supply (or forge) them in.
/// </summary>
public sealed record PoVoxelStrikeRunRequest(
    int Score, double SurvivalSeconds, int Kills, int BruteKills, int CrushKills, int VoxelsDestroyed);

internal static partial class PoVoxelStrikeLog
{
    [LoggerMessage(Level = LogLevel.Information,
        Message = "PoVoxelStrike run saved user={UserId} guest={IsGuest} score={Score}")]
    public static partial void ScoreSaved(ILogger logger, string userId, bool isGuest, int score);

    [LoggerMessage(Level = LogLevel.Warning,
        Message = "PoVoxelStrike run rejected: score={Score} ({Reason})")]
    public static partial void ScoreRejected(ILogger logger, int score, string reason);
}

/// <summary>Manifest row for one converted asset. <c>Url</c> is base-relative so the WASM client resolves it against its own origin.</summary>
public sealed record VoxelAssetManifestEntry(string Hash, string Name, int[] Dims, long SizeBytes, string Url);

/// <summary>
/// Rejects malformed hashes before the handler runs. The hash is the only client-supplied
/// path component that ever nears the filesystem, so this shape check is also the
/// path-traversal guard — nothing that fails it touches the catalog or disk.
/// </summary>
internal sealed partial class PvxHashEndpointFilter : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        if (context.HttpContext.Request.RouteValues["hash"] is not string hash || !HashPattern().IsMatch(hash))
        {
            return Results.ValidationProblem(new Dictionary<string, string[]>
            {
                ["hash"] = ["Asset hash must be 64 lowercase hex characters."],
            });
        }
        return await next(context);
    }

    [GeneratedRegex("^[0-9a-f]{64}$")]
    private static partial Regex HashPattern();
}
