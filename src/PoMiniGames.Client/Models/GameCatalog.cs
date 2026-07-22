namespace PoMiniGamesClient.Models;

/// <summary>A single game entry shown under a home-page section.</summary>
public sealed record CatalogGame(GameKey Key, string Title, string Icon, string Url);

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

    public static readonly IReadOnlyList<CatalogGame> Multiplayer =
    [
        new(GameKeys.PoRacer, "Racer", "🏎️", "/poracer/multi"),
        new(GameKeys.PoCoupleQuiz, "Couple Quiz", "💕", "/couplequiz/multi"),
        new(GameKeys.PoFunQuiz, "Fun Quiz", "🧠", "/funquiz/multi"),
        new(GameKeys.PoSports, "Sports", "🏃", "/posports/multi"),
    ];

    public static readonly IReadOnlyList<CatalogGame> Demo =
    [
        new(GameKeys.TicTacToe, "Tic-Tac-Toe", "❌", "/tictactoe/demo"),
        new(GameKeys.ConnectFive, "Connect Five", "🔴", "/connectfive/demo"),
        new(GameKeys.PoRacer, "Racer", "🏎️", "/poracer/demo"),
        new(GameKeys.PoMarbleRace, "Marble Race", "🔮", "/pomarblerace/demo"),
        new(GameKeys.PoJoker, "Joker", "🃏", "/pojoker/demo"),
        new(GameKeys.PoBrawl, "Brawl", "🥊", "/pobrawl/demo"),
        new(GameKeys.PoSurvive, "Survive", "🛡️", "/posurvive/demo"),
        new(GameKeys.PoSports, "Sports", "🏃", "/posports/demo"),
    ];
}
