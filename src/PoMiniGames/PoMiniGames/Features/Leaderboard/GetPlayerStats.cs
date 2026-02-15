using PoMiniGames.DTOs;
using PoMiniGames.Models;
using PoMiniGames.Services;

namespace PoMiniGames.Features.Leaderboard;

/// <summary>Retrieve a single player's stats for a specific game.</summary>
public static class GetPlayerStatsEndpoint
{
    public static IEndpointRouteBuilder MapGetPlayerStats(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/{game}/players/{playerName}/stats",
            async (string game, string playerName, StorageService storage) =>
        {
            var stats = await storage.GetPlayerStatsAsync(game, playerName);
            if (stats == null)
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
}
