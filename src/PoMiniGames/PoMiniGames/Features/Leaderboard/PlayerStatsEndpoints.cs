using PoMiniGames.Application.DTOs;
using PoMiniGames.Application.Services;
using PoMiniGames.Domain.Models;

namespace PoMiniGames.Features.Leaderboard;

/// <summary>
/// Consolidated minimal API endpoints for player statistics and leaderboards.
/// </summary>
public static class PlayerStatsEndpoints
{
    public static IEndpointRouteBuilder MapGetPlayerStats(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/{game}/players/{playerName}/stats",
            async (string game, string playerName, IStorageService storage) =>
            {
                var stats = await storage.GetPlayerStatsAsync(game, playerName);
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
            .WithTags("Players")
            .WithSummary("Retrieve stats for a player in a specific game")
            .Produces<PlayerStatsDto>(StatusCodes.Status200OK);

        return app;
    }

    public static IEndpointRouteBuilder MapSavePlayerStats(this IEndpointRouteBuilder app)
    {
        app.MapPut("/api/{game}/players/{playerName}/stats",
            async (string game, string playerName, PlayerStats stats, IStorageService storage) =>
            {
                if (string.IsNullOrWhiteSpace(playerName))
                {
                    return Results.BadRequest("Player name cannot be empty");
                }

                if (!IsValidStats(stats))
                {
                    return Results.BadRequest("Stats cannot have negative values");
                }

                await storage.SavePlayerStatsAsync(game, playerName, stats);
                return Results.NoContent();
            })
            .RequireAuthorization()
            .WithName("SavePlayerStats")
            .WithTags("Players")
            .WithSummary("Save or update player statistics for a game")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status401Unauthorized);

        return app;
    }

    public static IEndpointRouteBuilder MapGetLeaderboard(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/{game}/statistics/leaderboard",
            async (string game, IStorageService storage, int limit = 10, string? difficulty = null) =>
            {
                limit = Math.Clamp(limit, 1, 100);
                var board = await storage.GetLeaderboardAsync(game, limit, difficulty);
                var result = board
                    .Select(p => new PlayerStatsDto { Name = p.Name, Game = game, Stats = p.Stats })
                    .ToList();
                return Results.Ok(result);
            })
            .WithName("GetLeaderboard")
            .WithTags("Statistics")
            .WithSummary("Top players for a game ranked by win rate or difficulty-based ELO")
            .Produces<IEnumerable<PlayerStatsDto>>(StatusCodes.Status200OK);

        return app;
    }

    public static IEndpointRouteBuilder MapGetAllPlayerStatistics(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/statistics", async (IStorageService storage) =>
            {
                var result = await storage.GetAllPlayerStatsAsync();
                return Results.Ok(result);
            })
            .RequireAuthorization()
            .WithName("GetAllPlayerStatistics")
            .WithTags("Statistics")
            .WithSummary("All player statistics across every game")
            .Produces<IEnumerable<PlayerStatsDto>>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status401Unauthorized);

        // Documented cross-game save surface (POST /api/statistics). Resolves
        // gameId + playerName from the JSON body and delegates to the
        // existing per-game PUT handler so there's exactly one persistence path.
        // §6 of QA report: accept BOTH `gameId` (canonical, OpenAPI-documented) and
        // `gameKey` (legacy alias used by some pre-consolidation clients) and
        // surface a precise validation error naming which field was missing.
        app.MapPost("/api/statistics",
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
                var stats = raw.Stats ?? new PlayerStats();
                // If the client sent a flat { score, outcome } shape, fold it into
                // the default difficulty bucket so simple callers don't have to
                // supply the full nested schema. WinRate / TotalWins / TotalGames
                // are computed properties on PlayerStats, so only the mutable
                // counter fields are set.
                if (raw.Score is not null)
                {
                    var won = raw.Outcome?.Equals("win", StringComparison.OrdinalIgnoreCase) == true;
                    stats.Easy.Wins = won ? 1 : 0;
                    stats.Easy.Losses = won ? 0 : 1;
                    stats.Easy.TotalGames = 1;
                }
                await storage.SavePlayerStatsAsync(gameId!, playerName!, stats);
                return Results.NoContent();
            })
            .RequireAuthorization()
            .WithName("SavePlayerStatistics")
            .WithTags("Statistics")
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

        return stats.Wins >= 0
            && stats.Losses >= 0
            && stats.Draws >= 0
            && stats.TotalGames >= 0
            && stats.WinStreak >= 0;
    }
}
