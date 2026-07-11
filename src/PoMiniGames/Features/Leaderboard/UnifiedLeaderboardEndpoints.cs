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
        ("poracer", "PoRacer"),
        ("posurvive", "PoSurvive"),
        ("poface", "PoFace"),
    ];

    public static IEndpointRouteBuilder MapUnifiedLeaderboardEndpoints(this IEndpointRouteBuilder app)
    {
        // §1 MapGroup() per slice: /api/leaderboards/{game} reuses the parent prefix.
        var boards = app.MapGroup("/api/leaderboards").WithTags("Statistics");

        boards.MapGet("",
            async (IStorageService storage, int limit = 5) =>
            {
                limit = Math.Clamp(limit, 1, 100);
                var all = await BuildAllAsync(storage, limit);
                return Results.Ok(all);
            })
            .WithName("GetUnifiedLeaderboards")
            .WithSummary("Normalized leaderboards for every game in one call")
            .Produces<IEnumerable<GameLeaderboardDto>>(StatusCodes.Status200OK);

        boards.MapGet("/{game}",
            async (string game, IStorageService storage, int limit = 10) =>
            {
                limit = Math.Clamp(limit, 1, 100);
                var board = await BuildOneAsync(storage, game, limit);
                return board is null ? Results.NotFound(new { message = $"No leaderboard for game '{game}'" })
                                     : Results.Ok(board);
            })
            .WithName("GetUnifiedLeaderboard")
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

        // Boards with at least one REAL entry float to the top (every board is now
        // padded to `limit` with XXX placeholders, so raw count no longer ranks).
        return result.OrderByDescending(b => b.Entries.Count(e => e.Name != PlaceholderName)).ToList();
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

    /// <summary>
    /// Placeholder name for the dummy rows that pad every board out to the requested
    /// limit. Real scores always rank above the padding (they are appended after the
    /// ranked entries); clients that don't want the padding filter on this name.
    /// Padding lives here in the BFF rather than as seeded storage records because
    /// the PlayerStats table keys rows by player name — ten identical "XXX" rows
    /// per game cannot exist in storage, and fake stats rows would leak into the
    /// /api/statistics aggregates and ELO maths.
    /// </summary>
    public const string PlaceholderName = "XXX";

    private static void PadWithPlaceholders(List<LeaderboardEntryDto> entries, int limit, string zeroDisplay)
    {
        for (var rank = entries.Count + 1; rank <= limit; rank++)
        {
            entries.Add(new LeaderboardEntryDto(rank, PlaceholderName, 0, zeroDisplay));
        }
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
        PadWithPlaceholders(entries, limit, 0d.ToString("P0", CultureInfo.InvariantCulture));
        return new GameLeaderboardDto(key, title, "Win rate", HigherIsBetter: true, entries);
    }

    private static async Task<GameLeaderboardDto> BuildMarbleAsync(IStorageService storage, int limit)
    {
        var scores = await storage.GetMarbleRaceHighScoresAsync(limit);
        var entries = scores
            .Select((s, i) => new LeaderboardEntryDto(
                i + 1, s.PlayerInitials, s.BestScore, s.BestScore.ToString("N0", CultureInfo.InvariantCulture)))
            .ToList();
        PadWithPlaceholders(entries, limit, "0");
        return new GameLeaderboardDto("pomarblerace", "PoMarbleRace", "Points", HigherIsBetter: true, entries);
    }
}
