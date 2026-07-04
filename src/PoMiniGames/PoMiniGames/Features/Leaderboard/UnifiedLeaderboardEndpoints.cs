using System.Globalization;
using PoMiniGames.Application.DTOs;
using PoMiniGames.Application.Services;

namespace PoMiniGames.Features.Leaderboard;

/// <summary>
/// One read-model for every game's leaderboard. Collapses the win-rate stat boards and the
/// per-game high-score boards (snake, marble, drop-square) behind a single normalized shape
/// (<see cref="GameLeaderboardDto"/>) so the client renders all of them with one component and
/// always shows the correct unit. This is the BFF half of the "unified leaderboard" slice.
/// </summary>
public static class UnifiedLeaderboardEndpoints
{
    // Games ranked by win rate via the shared PlayerStats board.
    // Bug fix QA #3: surface every game from the home catalog so the Leaderboards
    // page chip count matches the home tile count (was 8 vs. 16).
    private static readonly (string Key, string Title)[] WinRateGames =
    [
        ("connectfive", "Connect Five"),
        ("tictactoe", "Tic Tac Toe"),
        ("poclick", "PoClick"),
        ("porunner", "PoRunner"),
        ("poracer", "PoRacer"),
        ("posurvive", "PoSurvive"),
        ("poface", "PoFace"),
    ];

    public static IEndpointRouteBuilder MapUnifiedLeaderboardEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/leaderboards",
            async (IStorageService storage, int limit = 5) =>
            {
                limit = Math.Clamp(limit, 1, 100);
                var boards = await BuildAllAsync(storage, limit);
                return Results.Ok(boards);
            })
            .WithName("GetUnifiedLeaderboards")
            .WithTags("Statistics")
            .WithSummary("Normalized leaderboards for every game in one call")
            .Produces<IEnumerable<GameLeaderboardDto>>(StatusCodes.Status200OK);

        app.MapGet("/api/leaderboards/{game}",
            async (string game, IStorageService storage, int limit = 10) =>
            {
                limit = Math.Clamp(limit, 1, 100);
                var board = await BuildOneAsync(storage, game, limit);
                return board is null ? Results.NotFound(new { message = $"No leaderboard for game '{game}'" })
                                     : Results.Ok(board);
            })
            .WithName("GetUnifiedLeaderboard")
            .WithTags("Statistics")
            .WithSummary("Normalized leaderboard for a single game")
            .Produces<GameLeaderboardDto>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status404NotFound);

        return app;
    }

    private static async Task<List<GameLeaderboardDto>> BuildAllAsync(IStorageService storage, int limit)
    {
        var result = new List<GameLeaderboardDto>();

        foreach (var (key, title) in WinRateGames)
        {
            result.Add(await BuildWinRateAsync(storage, key, title, limit));
        }

        result.Add(await BuildMarbleAsync(storage, limit));

        // Boards with at least one entry float to the top; empty boards still ship so the
        // client can show a "be the first" prompt instead of hiding the game entirely.
        return result.OrderByDescending(b => b.Entries.Count).ToList();
    }

    private static async Task<GameLeaderboardDto?> BuildOneAsync(IStorageService storage, string game, int limit)
    {
        var key = game.ToLowerInvariant();
        var winRate = Array.Find(WinRateGames, g => g.Key == key);
        if (winRate.Key is not null)
            return await BuildWinRateAsync(storage, winRate.Key, winRate.Title, limit);

        return key switch
        {
            "pomarblerace" or "marblerace" => await BuildMarbleAsync(storage, limit),
            _ => null,
        };
    }

    private static async Task<GameLeaderboardDto> BuildWinRateAsync(
        IStorageService storage, string key, string title, int limit)
    {
        var board = await storage.GetLeaderboardAsync(key, limit);
        var entries = board
            .Select((p, i) => new LeaderboardEntryDto(
                i + 1, p.Name, p.Stats.WinRate,
                p.Stats.WinRate.ToString("P0", CultureInfo.InvariantCulture)))
            .ToList();
        return new GameLeaderboardDto(key, title, "Win rate", HigherIsBetter: true, entries);
    }

    private static async Task<GameLeaderboardDto> BuildMarbleAsync(IStorageService storage, int limit)
    {
        var scores = await storage.GetMarbleRaceHighScoresAsync(limit);
        var entries = scores
            .Select((s, i) => new LeaderboardEntryDto(
                i + 1, s.PlayerInitials, s.BestScore, s.BestScore.ToString("N0", CultureInfo.InvariantCulture)))
            .ToList();
        return new GameLeaderboardDto("pomarblerace", "PoMarbleRace", "Points", HigherIsBetter: true, entries);
    }
}
