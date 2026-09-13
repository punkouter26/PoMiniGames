using System.Text.Json;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Integrity;

namespace PoMiniGames.Features.Leaderboard;

/// <summary>
/// Consolidated minimal API endpoints for player statistics and leaderboards.
/// </summary>
public static class PlayerStatsEndpoints
{
    public static IEndpointRouteBuilder MapGetPlayerStats(this IEndpointRouteBuilder app)
    {
        // §1 MapGroup() per slice: /api/{game}/players/{playerName}/stats lives under
        // a per-game group so the {game} placeholder is captured once at the boundary.
        var player = app.MapGroup("/{game}/players/{playerName}").WithTags("Players");

        player.MapGet("/stats",
            async (string game, string playerName, IStorageService storage,
                   IScoreIntegrityGuard integrity) =>
            {
                // Resolved through the SAME moderation the PUT below applies, because that is
                // what decides the RowKey. Read the raw route name while the write stores the
                // moderated one and a player whose name is rewritten writes to one key and
                // reads from another — their stats come back empty with nothing to show why.
                // Only normalisation is shared, not the write's identity override: this route
                // is still allowed to name a player, which is the whole point of the parameter.
                var key = integrity.ResolveDisplayName(playerName, playerName);
                var stats = await storage.GetPlayerStatsAsync(game, key);
                if (stats is null)
                {
                    return Results.NotFound(new { message = $"Player '{playerName}' not found in game '{game}'" });
                }

                return Results.Ok(new PlayerStatsDto
                {
                    Name = playerName,
                    Game = game,
                    Stats = stats,
                });
            })
            .WithName("GetPlayerStats")
            .WithSummary("Retrieve stats for a player in a specific game")
            .Produces<PlayerStatsDto>(StatusCodes.Status200OK);

        return app;
    }

    public static IEndpointRouteBuilder MapSavePlayerStats(this IEndpointRouteBuilder app)
    {
        // §1 MapGroup() per slice: companion PUT to the GET above shares the
        // {game}/players/{playerName} prefix group so auth + tag apply once.
        var player = app.MapGroup("/{game}/players/{playerName}").WithTags("Players");

        player.MapPut("/stats",
            async (string game, string playerName, PlayerStats stats, HttpContext http,
                   IStorageService storage, IScoreIntegrityGuard integrity) =>
            {
                // §8 allow-list: reject unknown game keys instead of silently creating an
                // arbitrary partition. Only the well-known catalogue may carry stats.
                if (GameKey.TryParse(game) is null)
                {
                    return Results.BadRequest(new { error = $"Unknown game key '{game}'" });
                }

                // §1 server-authoritative identity: a signed-in caller may only write their
                // OWN stats row. The route {playerName} is ignored for authenticated users —
                // the persisted key is the caller's claim identity — so nobody can PUT to
                // /players/{victim}/stats and overwrite another player's leaderboard row.
                var identity = RequestIdentity.Resolve(http.User);
                var claimed = identity.IsAuthenticated && !string.IsNullOrWhiteSpace(identity.DisplayName)
                    ? identity.DisplayName
                    : playerName;

                if (string.IsNullOrWhiteSpace(claimed))
                {
                    return Results.BadRequest("Player name cannot be empty");
                }

                // The win-rate board renders this value as the player's name on a page that is
                // readable without signing in, so it is moderated before it becomes a RowKey.
                // Note the side effect: for a name the sanitiser REWRITES, the row key changes
                // and the old row is orphaned rather than updated. That is confined to names
                // carrying invisible characters or collapsed whitespace — i.e. exactly the
                // abuse case — because normalisation is a no-op on an ordinary name.
                var owner = integrity.ResolveDisplayName(claimed, identity.IsGuest ? "Guest" : "Player");

                if (!IsValidStats(stats))
                {
                    return Results.BadRequest("Stats cannot have negative or out-of-range values");
                }

                await storage.SavePlayerStatsAsync(game, owner, stats);
                return Results.NoContent();
            })
            .RequireAuthorization()
            .WithName("SavePlayerStats")
            .WithSummary("Save or update player statistics for a game")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status401Unauthorized);

        return app;
    }

    public static IEndpointRouteBuilder MapGetLeaderboard(this IEndpointRouteBuilder app)
    {
        // §1 MapGroup() per slice: per-game leaderboard under /api/{game}/statistics.
        // NOTE the absolute "/api" here, unlike its three siblings in this file. This is
        // the one endpoint in the class that EndpointRouteExtensions maps on `app` rather
        // than on the authenticated gameApi group — leaderboard READS are anonymous (§10)
        // — so it does not inherit the group's "/api" prefix and must spell it itself.
        var stats = app.MapGroup("/api/{game}/statistics").WithTags("Statistics");

        stats.MapGet("/leaderboard",
            async (string game, IStorageService storage, int limit = 10, string? difficulty = null) =>
            {
                if (GameKey.TryParse(game) is null)
                {
                    return Results.BadRequest(new { error = $"Unknown game key '{game}'" });
                }
                limit = Math.Clamp(limit, 1, 100);
                var board = await storage.GetLeaderboardAsync(game, limit, difficulty);
                var result = board
                    .Select(p => new PlayerStatsDto { Name = p.Name, Game = game, Stats = p.Stats })
                    .ToList();
                return Results.Ok(result);
            })
            .WithName("GetLeaderboard")
            .WithSummary("Top players for a game ranked by win rate or difficulty-based ELO")
            .Produces<IEnumerable<PlayerStatsDto>>(StatusCodes.Status200OK);

        return app;
    }

    public static IEndpointRouteBuilder MapGetAllPlayerStatistics(this IEndpointRouteBuilder app)
    {
        // §1 MapGroup() per slice: cross-game statistics live under /api/statistics.
        var stats = app.MapGroup("/statistics").WithTags("Statistics");

        stats.MapGet("", async (IStorageService storage) =>
        {
            var summary = await storage.GetLeaderboardAsync("connectfive", 5);
            var dtos = summary.Select(p => new PlayerStatsDto { Name = p.Name, Game = "connectfive", Stats = p.Stats }).ToList();
            return Results.Ok(dtos);
        })
        .WithName("GetAllStatistics")
        .WithSummary("Retrieve aggregated statistics summary")
        .Produces<IEnumerable<PlayerStatsDto>>(StatusCodes.Status200OK);

        // Documented cross-game save surface (POST /api/statistics). Resolves
        // gameId + playerName from the JSON body and delegates to the
        // existing per-game PUT handler so there's exactly one persistence path.
        // §6 of QA report: accept BOTH `gameId` (canonical, OpenAPI-documented) and
        // `gameKey` (legacy alias used by some pre-consolidation clients) and
        // surface a precise validation error naming which field was missing.
        stats.MapPost("",
            async (HttpContext context, PlayerStatsSubmissionRaw raw, IStorageService storage) =>
            {
                if (raw is null)
                {
                    return Results.BadRequest(new { error = "request body is required" });
                }
                var gameId = !string.IsNullOrWhiteSpace(raw.GameId) ? raw.GameId : raw.GameKey;
                var playerName = !string.IsNullOrWhiteSpace(raw.PlayerName) ? raw.PlayerName : raw.Player;
                var missing = new List<string>();
                if (string.IsNullOrWhiteSpace(gameId)) missing.Add("gameId");
                if (string.IsNullOrWhiteSpace(playerName)) missing.Add("playerName");
                if (raw.Stats is null && raw.Score is null) missing.Add("stats");
                if (missing.Count > 0)
                {
                    return Results.BadRequest(new
                    {
                        error = "validation_failed",
                        missing,
                        hint = "POST { gameId, playerName, stats } to /api/statistics. `gameKey` is accepted as a legacy alias of `gameId`."
                    });
                }
                // §8 allow-list: reject unknown game keys before persisting.
                if (GameKey.TryParse(gameId) is null)
                {
                    return Results.BadRequest(new { error = $"Unknown game key '{gameId}'" });
                }
                // §1 server-authoritative identity: override the body's playerName with the
                // caller's claim so a signed-in user can only write their own row.
                var identity = RequestIdentity.Resolve(context.User);
                if (identity.IsAuthenticated && !string.IsNullOrWhiteSpace(identity.DisplayName))
                {
                    playerName = identity.DisplayName;
                }
                var stats2 = raw.Stats ?? new PlayerStats();
                // If the client sent a flat { score, outcome } shape, fold it into
                // the default difficulty bucket so simple callers don't have to
                // supply the full nested schema. WinRate / TotalWins / TotalGames
                // are computed properties on PlayerStats, so only the mutable
                // counter fields are set.
                if (raw.Score is not null)
                {
                    var won = raw.Outcome?.Equals("win", StringComparison.OrdinalIgnoreCase) == true;
                    stats2.Easy.Wins = won ? 1 : 0;
                    stats2.Easy.Losses = won ? 0 : 1;
                    stats2.Easy.TotalGames = 1;
                }
                await storage.SavePlayerStatsAsync(gameId!, playerName!, stats2);
                return Results.NoContent();
            })
            .RequireAuthorization()
            .WithName("SavePlayerStatistics")
            .WithSummary("Save or upsert a player's stats for a single game (body supplies gameId + playerName + stats). gameKey is accepted as a legacy alias.")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized);

        return app;
    }

    /// <summary>
    /// Wire format for <c>POST /api/statistics</c>. Accepts both the canonical
    /// <c>gameId</c> and the legacy <c>gameKey</c>; either suffices. The flat
    /// <c>score</c> / <c>outcome</c> shape is folded into the easy-difficulty
    /// bucket so simple callers don't need to send the full nested schema.
    /// </summary>
    public sealed record PlayerStatsSubmissionRaw(
        [property: System.Text.Json.Serialization.JsonPropertyName("gameId")] string? GameId,
        [property: System.Text.Json.Serialization.JsonPropertyName("gameKey")] string? GameKey,
        [property: System.Text.Json.Serialization.JsonPropertyName("playerName")] string? PlayerName,
        [property: System.Text.Json.Serialization.JsonPropertyName("player")] string? Player,
        [property: System.Text.Json.Serialization.JsonPropertyName("stats")] PlayerStats? Stats,
        [property: System.Text.Json.Serialization.JsonPropertyName("score")] double? Score,
        [property: System.Text.Json.Serialization.JsonPropertyName("outcome")] string? Outcome);

    private static bool IsValidStats(PlayerStats? stats)
    {
        if (stats is null)
        {
            return false;
        }

        return IsValidDifficultyStats(stats.Easy)
            && IsValidDifficultyStats(stats.Medium)
            && IsValidDifficultyStats(stats.Hard);
    }

    private static bool IsValidDifficultyStats(DifficultyStats? stats)
    {
        if (stats is null)
        {
            return true;
        }

        // EloRating is client-authoritative for adaptive-ELO games (they mirror their
        // evolving skill rating into the bucket), but it must stay within the same range
        // the client itself clamps to (100–3000). A wider ceiling here (4000) leaves
        // headroom while rejecting a tampered int.MaxValue that would own the board.
        return stats.Wins >= 0
            && stats.Losses >= 0
            && stats.Draws >= 0
            && stats.TotalGames >= 0
            && stats.WinStreak >= 0
            && stats.EloRating is >= 0 and <= 4000;
    }
}
