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
    // Games ranked via the shared PlayerStats board: adaptive-ELO games rank by
    // rating. Every other board has a real score source and a dedicated builder
    // below. PoSurvive is demo-only — no board.
    private static readonly (string Key, string Title)[] WinRateGames =
    [
        ("connectfive", "Connect Five"),
        // Renamed to "TicTacToe6" (6×6 / 4-in-a-row grid) to match the catalog,
        // profile, and in-game labels; the storage key stays "tictactoe".
        ("tictactoe", "TicTacToe6"),
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

    private static async Task<List<GameLeaderboardDto>> BuildAllAsync(
        IStorageService storage, int limit)
    {
        // §6: each board is an independent storage read, so fan them out concurrently instead
        // of awaiting one at a time. Wall-clock drops from the SUM of the per-board scans to
        // the slowest single one.
        var winRateTasks = WinRateGames.Select(g => BuildWinRateAsync(storage, g.Key, g.Title, limit));
        var boardTasks = new[]
        {
            BuildMarbleAsync(storage, limit),
            BuildPoRacerAsync(storage, limit),
            BuildPoBrawlAsync(storage, limit),
        };

        var result = (await Task.WhenAll(winRateTasks.Concat(boardTasks))).ToList();

        // Boards with at least one REAL entry float to the top (every board is now
        // padded to `limit` with XXX placeholders, so raw count no longer ranks).
        return result.OrderByDescending(b => b.Entries.Count(e => e.Name != PlaceholderName)).ToList();
    }

    private static async Task<GameLeaderboardDto?> BuildOneAsync(
        IStorageService storage, string game, int limit)
    {
        var key = game.ToLowerInvariant();
        var winRate = Array.Find(WinRateGames, g => g.Key == key);
        if (winRate.Key is not null)
            return await BuildWinRateAsync(storage, winRate.Key, winRate.Title, limit);

        return key switch
        {
            "pomarblerace" or "marblerace" => await BuildMarbleAsync(storage, limit),
            "poracer" => await BuildPoRacerAsync(storage, limit),
            "pobrawl" => await BuildPoBrawlAsync(storage, limit),
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

    /// <summary>
    /// Games whose 1-player CPU is matched to the player's adaptive ELO. Their
    /// boards rank by that rating — the adaptive matchmaking pins win rate near
    /// 50% by design, so win rate can't distinguish players. The client mirrors
    /// the adaptive rating into the Medium bucket's EloRating on every game.
    /// </summary>
    private static readonly HashSet<string> AdaptiveEloGames = ["connectfive", "tictactoe"];

    private static async Task<GameLeaderboardDto> BuildWinRateAsync(
        IStorageService storage, string key, string title, int limit)
    {
        if (AdaptiveEloGames.Contains(key))
        {
            var eloBoard = await storage.GetLeaderboardAsync(key, limit, "medium");
            var eloEntries = eloBoard
                .Select((p, i) => new LeaderboardEntryDto(
                    i + 1, p.Name, p.Stats.Medium.EloRating,
                    p.Stats.Medium.EloRating.ToString("N0", CultureInfo.InvariantCulture)))
                .ToList();
            PadWithPlaceholders(eloEntries, limit, "0");
            return new GameLeaderboardDto(key, title, "ELO", HigherIsBetter: true, eloEntries);
        }

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
        return new GameLeaderboardDto("pomarblerace", "Marble Race", "Points", HigherIsBetter: true, entries);
    }

    /// <summary>Best race time per player (lower is better) from the PoRacer score table.</summary>
    private static async Task<GameLeaderboardDto> BuildPoRacerAsync(IStorageService storage, int limit)
    {
        var scores = await storage.GetPoRacerHighScoresAsync(50);
        var entries = scores
            .Where(s => s.TotalTimeSeconds > 0)
            .GroupBy(s => s.PlayerName)
            .Select(g => (Name: g.Key, Best: g.Min(s => s.TotalTimeSeconds)))
            .OrderBy(x => x.Best)
            .Take(limit)
            .Select((x, i) => new LeaderboardEntryDto(
                i + 1, x.Name, x.Best,
                x.Best.ToString("0.0", CultureInfo.InvariantCulture) + "s"))
            .ToList();
        PadWithPlaceholders(entries, limit, "—");
        return new GameLeaderboardDto("poracer", "Racer", "Best time", HigherIsBetter: false, entries);
    }

    /// <summary>
    /// PoBrawl ranks by the level of opponent conquered: highest presidential
    /// ladder rung beaten (1-10, each rung a harder CPU), ties broken by the
    /// player's fastest KO time, then ELO. Displays as "N/10".
    /// </summary>
    private static async Task<GameLeaderboardDto> BuildPoBrawlAsync(IStorageService storage, int limit)
    {
        var ladder = await storage.GetPoBrawlLadderAsync(50);
        var kos = await storage.GetPoBrawlHighScoresAsync(50);

        // KO rows now carry the full player name; legacy rows hold 3-letter
        // initials. Join by exact name first, initials as the legacy fallback.
        var bestKoByName = kos
            .Where(k => k.KoTimeSeconds > 0)
            .GroupBy(k => k.PlayerInitials)
            .ToDictionary(g => g.Key, g => g.Min(k => k.KoTimeSeconds));

        double BestKo(string playerName) =>
            bestKoByName.TryGetValue(playerName, out var exact) ? exact
            : bestKoByName.TryGetValue(InitialsOf(playerName), out var legacy) ? legacy
            : double.MaxValue;

        var entries = ladder
            .OrderByDescending(l => l.PresidentsBeaten)
            .ThenBy(l => BestKo(l.PlayerName))
            .ThenByDescending(l => l.Elo)
            .Take(limit)
            .Select((l, i) => new LeaderboardEntryDto(
                i + 1, l.PlayerName, l.PresidentsBeaten, $"{l.PresidentsBeaten}/10"))
            .ToList();
        PadWithPlaceholders(entries, limit, "0/10");
        return new GameLeaderboardDto("pobrawl", "Brawl", "Ladder", HigherIsBetter: true, entries);
    }

    /// <summary>Mirror of the client's Initials(): first 3 alphanumeric chars, uppercased.</summary>
    private static string InitialsOf(string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return "PO";
        var letters = new string(name.Where(char.IsLetterOrDigit).ToArray());
        if (letters.Length == 0) return "PO";
        return letters[..Math.Min(3, letters.Length)].ToUpperInvariant();
    }
}
