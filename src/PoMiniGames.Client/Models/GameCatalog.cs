namespace PoMiniGamesClient.Models;

/// <summary>One playable mode of one game.</summary>
/// <param name="RequiresNetwork">
/// True when this specific mode cannot run without a live server — a SignalR hub for
/// multiplayer, or a server API the game calls mid-round. With the service worker
/// installed the app shell loads fine offline, so these would otherwise present as
/// playable and then fail at the point of no return (a lobby that never connects).
/// Modes marked here are shown as unavailable while offline instead.
/// <para>
/// This is per-<i>mode</i>, not per-game: PoSurvive's 1-player runs entirely on the
/// scripted provider and is fully offline-playable, while PoJoker needs the joke API
/// in every mode.
/// </para>
/// </param>
public sealed record CatalogMode(GameMode Mode, string Url, bool RequiresNetwork = false);

/// <summary>
/// A game and every mode it can actually be played in. One entry per game — the
/// home page renders one card per game with a chip per mode, so a game can no
/// longer go missing from a mode it supports.
/// </summary>
/// <param name="Subtitle">
/// Optional one-line clarification rendered under the card title. Used where the
/// product name does not by itself tell the player what variant they are about
/// to play (e.g. Tic-Tac-Toe is actually 4-in-a-row on a 6×6 grid). Null for the
/// common case where the title is unambiguous.
/// </param>
public sealed record CatalogGame(GameKey Key, string Title, string Icon, IReadOnlyList<CatalogMode> Modes)
{
    /// <summary>Optional one-line clarification rendered under the card title on the
    /// home page. See <see cref="CatalogGame"/> remarks.</summary>
    public string? Subtitle { get; init; }

    /// <summary>The mode a card's title links to — the richest interactive mode available.
    /// Demo is last-resort only: a card whose primary action is "watch" is a card the
    /// player cannot play.</summary>
    public CatalogMode Primary =>
        Modes.FirstOrDefault(m => m.Mode == GameMode.OnePlayer)
        ?? Modes.FirstOrDefault(m => m.Mode == GameMode.Multiplayer)
        ?? Modes.FirstOrDefault(m => m.Mode == GameMode.TwoPlayer)
        ?? Modes[0];

    public CatalogMode? Find(GameMode mode) => Modes.FirstOrDefault(m => m.Mode == mode);
}

/// <summary>A single game+mode pair, flattened. Used by the per-mode views below.</summary>
public sealed record CatalogEntry(
    GameKey Key, string Title, string Icon, string Url, GameMode Mode, bool RequiresNetwork);

/// <summary>
/// The canonical list of every game and every mode it supports.
/// </summary>
/// <remarks>
/// <para>
/// Previously this was four hand-maintained per-mode lists, and they drifted: PoSurvive
/// (the largest game in the repo) and PoJoker appeared <i>only</i> under Demo, so both
/// were watch-only from the home page despite having working interactive routes. Fun
/// Quiz and Couple Quiz had the same gap for single-player. Modelling the game once,
/// with its modes attached, is what makes that class of omission visible.
/// </para>
/// <para>
/// Every URL uses the uniform mode-suffix scheme — /{game}/1player, /{game}/2player,
/// /{game}/multi, /{game}/demo — so the mode is readable straight off the address bar.
/// Legacy forms (/{game}/1, ?mode=2p, ?demo=1, /lobby, /multiplayer) still route for old
/// bookmarks; <see cref="GameModes.Parse"/> is the single place that accepts them.
/// </para>
/// </remarks>
public static class GameCatalog
{
    public static readonly IReadOnlyList<CatalogGame> All =
    [
        new(GameKeys.ConnectFive, "Connect Five", "🔴",
        [
            new(GameMode.OnePlayer, "/connectfive/1player"),
            new(GameMode.TwoPlayer, "/connectfive/2player"),
            new(GameMode.Demo, "/connectfive/demo"),
        ]),

        // 2026-07-19 browser audit #8: the grid dimension (6×6 / 4-in-a-row) was
        // leaking into the product name as "TicTacToe6". Surface the classic product
        // name; the grid size stays in the in-game "How to play" copy and intro card.
        // Audit #10: the home card used to just say "Tic-Tac-Toe", which primed
        // visitors for the 3×3 / 3-in-a-row game they learned as a kid. This
        // variant is Connect-Four mechanics on a 6×6 grid — line up four in a
        // row, horizontally, vertically or diagonally. The Subtitle surfaces
        // that one-line clarification on the home card so the first move
        // matches the rules the player just read.
        new(GameKeys.TicTacToe, "Tic-Tac-Toe", "❌",
        [
            new(GameMode.OnePlayer, "/tictactoe/1player"),
            new(GameMode.TwoPlayer, "/tictactoe/2player"),
            new(GameMode.Demo, "/tictactoe/demo"),
        ])
        {
            Subtitle = "4-in-a-row · 6×6",
        },

        new(GameKeys.PoBrawl, "Brawl", "🥊",
        [
            new(GameMode.OnePlayer, "/pobrawl/1player"),
            new(GameMode.TwoPlayer, "/pobrawl/2player"),
            new(GameMode.Demo, "/pobrawl/demo"),
        ]),

        new(GameKeys.PoSports, "Sports", "🏃",
        [
            new(GameMode.OnePlayer, "/posports/1player"),
            new(GameMode.TwoPlayer, "/posports/2player"),
            new(GameMode.Multiplayer, "/posports/multi", RequiresNetwork: true),
            new(GameMode.Demo, "/posports/demo"),
        ]),

        new(GameKeys.PoRacer, "Racer", "🏎️",
        [
            new(GameMode.OnePlayer, "/poracer/1player"),
            new(GameMode.Multiplayer, "/poracer/multi", RequiresNetwork: true),
            new(GameMode.Demo, "/poracer/demo"),
        ]),

        new(GameKeys.PoMarbleRace, "Marble Race", "🔮",
        [
            new(GameMode.OnePlayer, "/pomarblerace/1player"),
            new(GameMode.Demo, "/pomarblerace/demo"),
        ]),

        // 1-player defaults to the scripted provider, so it runs fully offline. Only
        // picking a real model from the command bar reaches the relay, and that is an
        // explicit opt-in inside the game — not a precondition for playing it.
        new(GameKeys.PoSurvive, "Survive", "🛡️",
        [
            new(GameMode.OnePlayer, "/posurvive/1player"),
            new(GameMode.Demo, "/posurvive/demo"),
        ]),

        // Joker's set is fetched from a joke API mid-performance in every mode — there
        // is no offline joke bank to fall back on.
        new(GameKeys.PoJoker, "Joker", "🃏",
        [
            new(GameMode.OnePlayer, "/pojoker", RequiresNetwork: true),
            new(GameMode.Demo, "/pojoker/demo", RequiresNetwork: true),
        ]),

        // Questions come from /api/funquiz/quiz/questions, so even solo needs a server.
        new(GameKeys.PoFunQuiz, "Fun Quiz", "🧠",
        [
            new(GameMode.OnePlayer, "/funquiz/1player", RequiresNetwork: true),
            new(GameMode.TwoPlayer, "/funquiz/2player", RequiresNetwork: true),
            new(GameMode.Multiplayer, "/funquiz/multi", RequiresNetwork: true),
        ]),

        // Multiplayer only (user decision, 2026-08-10). The 1-player entry here never
        // started a 1-player game: /couplequiz/1player landed on the multiplayer lobby
        // card, which merely offered a "Play solo (vs AI partner)" button for a mode whose
        // "AI partner" was a hardcoded answer index. Both are gone. There is no Demo entry
        // because this game was never in the kiosk reel below.
        new(GameKeys.PoCoupleQuiz, "Couple Quiz", "💕",
        [
            new(GameMode.Multiplayer, "/couplequiz", RequiresNetwork: true),
        ]),
    ];

    /// <summary>Games sorted for display — alphabetical, matching the old per-section order.</summary>
    public static readonly IReadOnlyList<CatalogGame> AllSorted =
        All.OrderBy(g => g.Title, StringComparer.OrdinalIgnoreCase).ToList();

    private static IReadOnlyList<CatalogEntry> For(GameMode mode) =>
        All.Select(g => (game: g, mode: g.Find(mode)))
           .Where(x => x.mode is not null)
           .Select(x => new CatalogEntry(
               x.game.Key, x.game.Title, x.game.Icon, x.mode!.Url, mode, x.mode.RequiresNetwork))
           .OrderBy(e => e.Title, StringComparer.OrdinalIgnoreCase)
           .ToList();

    public static readonly IReadOnlyList<CatalogEntry> SinglePlayer = For(GameMode.OnePlayer);
    public static readonly IReadOnlyList<CatalogEntry> LocalTwoPlayer = For(GameMode.TwoPlayer);
    public static readonly IReadOnlyList<CatalogEntry> Multiplayer = For(GameMode.Multiplayer);

    /// <summary>
    /// The kiosk reel, in rotation order. Deliberately NOT alphabetical and NOT derived
    /// from <see cref="For"/>: the reel opens on the two quickest-to-read board games so a
    /// passer-by sees a full round early, and PoSurvive's long match sits late.
    /// </summary>
    public static readonly IReadOnlyList<CatalogEntry> Demo =
    [
        .. new[]
        {
            GameKeys.TicTacToe, GameKeys.ConnectFive, GameKeys.PoRacer, GameKeys.PoMarbleRace,
            GameKeys.PoJoker, GameKeys.PoBrawl, GameKeys.PoSurvive, GameKeys.PoSports,
        }
        .Select(key => All.First(g => g.Key == key))
        .Select(g =>
        {
            var demo = g.Find(GameMode.Demo)!;
            return new CatalogEntry(g.Key, g.Title, g.Icon, demo.Url, GameMode.Demo, demo.RequiresNetwork);
        }),
    ];
}
