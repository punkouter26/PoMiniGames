using PoMiniGames.DTOs;
using PoMiniGames.Models;
using PoMiniGames.Services;

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

        return app;
    }

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
