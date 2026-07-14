namespace PoMiniGamesClient.Models;

/// <summary>A single game entry shown under a home-page section.</summary>
public sealed record CatalogGame(GameKey Key, string Title, string Icon, string Url);

/// <summary>
/// The canonical list of games per home-page section (1 Player, 2 Player local,
/// Multiplayer online, Demo). Drives the game lists rendered beneath each mode
/// button on the home page. URLs mirror the existing single-player / online /
/// demo navigation targets.
/// </summary>
public static class GameCatalog
{
    public static readonly IReadOnlyList<CatalogGame> SinglePlayer =
    [
        new(GameKeys.ConnectFive, "Connect Five", "🔴", "/connectfive"),
        // NetRun10 audit #4: the page is actually a 6×6 / 4-in-a-row grid,
        // not the classic 3×3 tic-tac-toe. The user-facing title now matches
        // the in-game label and the "How to play" copy.
        new(GameKeys.TicTacToe, "TicTacToe6", "❌", "/tictactoe"),
        new(GameKeys.PoRacer, "Racer", "🏎️", "/poracer"),
        new(GameKeys.PoMarbleRace, "Marble Race", "🔮", "/pomarblerace"),
        new(GameKeys.PoBrawl, "Brawl", "🥊", "/pobrawl"),
    ];

    public static readonly IReadOnlyList<CatalogGame> LocalTwoPlayer =
    [
        new(GameKeys.ConnectFive, "Connect Five", "🔴", "/connectfive?mode=2p"),
        new(GameKeys.TicTacToe, "TicTacToe6", "❌", "/tictactoe?mode=2p"),
        new(GameKeys.PoBrawl, "Brawl", "🥊", "/pobrawl?mode=2p"),
    ];

    public static readonly IReadOnlyList<CatalogGame> Multiplayer =
    [
        new(GameKeys.PoRacer, "Racer", "🏎️", "/poracer/lobby"),
        new(GameKeys.PoCoupleQuiz, "Couple Quiz", "💕", "/couplequiz/lobby"),
        new(GameKeys.PoFunQuiz, "Fun Quiz", "🧠", "/funquiz/multiplayer"),
    ];

    public static readonly IReadOnlyList<CatalogGame> Demo =
    [
        new(GameKeys.TicTacToe, "TicTacToe6", "❌", "/tictactoe/1"),
        new(GameKeys.ConnectFive, "Connect Five", "🔴", "/connectfive/1"),
        new(GameKeys.PoRacer, "Racer", "🏎️", "/poracer/demo"),
        new(GameKeys.PoMarbleRace, "Marble Race", "🔮", "/pomarblerace?demo=1"),
        new(GameKeys.PoJoker, "Joker", "🃏", "/pojoker"),
        new(GameKeys.PoBrawl, "Brawl", "🥊", "/pobrawl/1"),
        new(GameKeys.PoSurvive, "Survive", "🛡️", "/posurvive?demo=1"),
    ];
}
