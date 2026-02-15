using PoMiniGames.DTOs;
using PoMiniGames.Services;

namespace PoMiniGames.Features.Leaderboard;

/// <summary>Retrieve statistics for all players across all games.</summary>
public static class GetAllPlayerStatisticsEndpoint
{
    public static IEndpointRouteBuilder MapGetAllPlayerStatistics(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/statistics", async (StorageService storage) =>
        {
            var result = await storage.GetAllPlayerStatsAsync();
            return Results.Ok(result);
        })
        .WithName("GetAllPlayerStatistics")
        .WithTags("Statistics")
        .WithSummary("All player statistics across every game")
        .Produces<IEnumerable<PlayerStatsDto>>(StatusCodes.Status200OK);

        return app;
    }
}
