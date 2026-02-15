using PoMiniGames.Models;
using PoMiniGames.Services;

namespace PoMiniGames.Features.Leaderboard;

/// <summary>Save or update player statistics for a specific game.</summary>
public static class SavePlayerStatsEndpoint
{
    public static IEndpointRouteBuilder MapSavePlayerStats(this IEndpointRouteBuilder app)
    {
        app.MapPut("/api/{game}/players/{playerName}/stats",
            async (string game, string playerName, PlayerStats stats, StorageService storage) =>
        {
            // Validate player name
            if (string.IsNullOrWhiteSpace(playerName))
                return Results.BadRequest("Player name cannot be empty");

            // Validate stats don't have negative values
            if (!IsValidStats(stats))
                return Results.BadRequest("Stats cannot have negative values");

            await storage.SavePlayerStatsAsync(game, playerName, stats);
            return Results.NoContent();
        })
        .WithName("SavePlayerStats")
        .WithTags("Players")
        .WithSummary("Save or update player statistics for a game")
        .Produces(StatusCodes.Status204NoContent);

        return app;
    }

    private static bool IsValidStats(PlayerStats? stats)
    {
        if (stats == null) return false;
        return IsValidDifficultyStats(stats.Easy) &&
               IsValidDifficultyStats(stats.Medium) &&
               IsValidDifficultyStats(stats.Hard);
    }

    private static bool IsValidDifficultyStats(DifficultyStats? ds)
    {
        if (ds == null) return true;
        return ds.Wins >= 0 && ds.Losses >= 0 && ds.Draws >= 0 && ds.TotalGames >= 0 && ds.WinStreak >= 0;
    }
}
