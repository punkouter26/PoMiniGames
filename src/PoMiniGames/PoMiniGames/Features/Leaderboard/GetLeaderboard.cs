using PoMiniGames.DTOs;
using PoMiniGames.Services;

namespace PoMiniGames.Features.Leaderboard;

/// <summary>Retrieve leaderboard for a specific game.</summary>
public static class GetLeaderboardEndpoint
{
    public static IEndpointRouteBuilder MapGetLeaderboard(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/{game}/statistics/leaderboard",
            async (string game, StorageService storage, int limit = 10) =>
        {
            var board = await storage.GetLeaderboardAsync(game, limit);
            var result = board
                .Select(p => new PlayerStatsDto { Name = p.Name, Game = game, Stats = p.Stats })
                .ToList();
            return Results.Ok(result);
        })
        .WithName("GetLeaderboard")
        .WithTags("Statistics")
        .WithSummary("Top players for a game ranked by win rate")
        .Produces<IEnumerable<PlayerStatsDto>>(StatusCodes.Status200OK);

        return app;
    }
}
