namespace PoMiniGamesClient.Models;

/// <summary>A single game entry shown under a home-page section.</summary>
/// <param name="RequiresNetwork">
/// True when the entry cannot run without a live server — a SignalR hub for
/// multiplayer, or a server API the game calls mid-round. With the service worker
/// installed the app shell loads fine offline, so these would otherwise present as
/// playable and then fail at the point of no return (a lobby that never connects).
/// Entries marked here are shown as unavailable while offline instead.
/// </param>
public sealed record CatalogGame(
    GameKey Key, string Title, string Icon, string Url, bool RequiresNetwork = false);

/// <summary>
/// The canonical list of games per home-page section (1 Player, 2 Player local,
/// Multiplayer online, Demo). Drives the game lists rendered beneath each mode
/// button on the home page. Every URL uses the uniform mode-suffix scheme —
/// /{game}/1player, /{game}/2player, /{game}/multi, /{game}/demo — so the mode
/// is readable straight off the address bar. Legacy forms (/{game}/1, ?mode=2p,
/// ?demo=1, /lobby, /multiplayer) still route for old bookmarks.
/// </summary>
public static class GameCatalog
{
    public static readonly IReadOnlyList<CatalogGame> SinglePlayer =
    [
        new(GameKeys.ConnectFive, "Connect Five", "🔴", "/connectfive/1player"),
        // 2026-07-19 browser audit #8: the grid dimension (6×6 / 4-in-a-row)
        // was leaking into the product name as "TicTacToe6". Surface the
        // classic product name; the grid size stays in the in-game "How to
        // play" copy and intro card.
        new(GameKeys.TicTacToe, "Tic-Tac-Toe", "❌", "/tictactoe/1player"),
        new(GameKeys.PoRacer, "Racer", "🏎️", "/poracer/1player"),
        new(GameKeys.PoMarbleRace, "Marble Race", "🔮", "/pomarblerace/1player"),
        new(GameKeys.PoBrawl, "Brawl", "🥊", "/pobrawl/1player"),
        new(GameKeys.PoSports, "Sports", "🏃", "/posports/1player"),
    ];

    public static readonly IReadOnlyList<CatalogGame> LocalTwoPlayer =
    [
        new(GameKeys.ConnectFive, "Connect Five", "🔴", "/connectfive/2player"),
        new(GameKeys.TicTacToe, "Tic-Tac-Toe", "❌", "/tictactoe/2player"),
        new(GameKeys.PoBrawl, "Brawl", "🥊", "/pobrawl/2player"),
        new(GameKeys.PoSports, "Sports", "🏃", "/posports/2player"),
    ];

    // Every entry here is hub-backed, so all of them require a live server.
    public static readonly IReadOnlyList<CatalogGame> Multiplayer =
    [
        new(GameKeys.PoRacer, "Racer", "🏎️", "/poracer/multi", RequiresNetwork: true),
        new(GameKeys.PoCoupleQuiz, "Couple Quiz", "💕", "/couplequiz/multi", RequiresNetwork: true),
        new(GameKeys.PoFunQuiz, "Fun Quiz", "🧠", "/funquiz/multi", RequiresNetwork: true),
        new(GameKeys.PoSports, "Sports", "🏃", "/posports/multi", RequiresNetwork: true),
    ];

    public static readonly IReadOnlyList<CatalogGame> Demo =
    [
        new(GameKeys.TicTacToe, "Tic-Tac-Toe", "❌", "/tictactoe/demo"),
        new(GameKeys.ConnectFive, "Connect Five", "🔴", "/connectfive/demo"),
        new(GameKeys.PoRacer, "Racer", "🏎️", "/poracer/demo"),
        new(GameKeys.PoMarbleRace, "Marble Race", "🔮", "/pomarblerace/demo"),
        // Joker's set is fetched from a joke API mid-performance — there is no
        // offline joke bank to fall back on.
        new(GameKeys.PoJoker, "Joker", "🃏", "/pojoker/demo", RequiresNetwork: true),
        new(GameKeys.PoBrawl, "Brawl", "🥊", "/pobrawl/demo"),
        new(GameKeys.PoSurvive, "Survive", "🛡️", "/posurvive/demo"),
        new(GameKeys.PoSports, "Sports", "🏃", "/posports/demo"),
    ];
}
