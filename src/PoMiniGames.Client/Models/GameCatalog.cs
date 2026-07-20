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
        // 2026-07-19 browser audit #8: the grid dimension (6×6 / 4-in-a-row)
        // was leaking into the product name as "TicTacToe6". Surface the
        // classic product name; the grid size stays in the in-game "How to
        // play" copy and intro card.
        new(GameKeys.TicTacToe, "Tic-Tac-Toe", "❌", "/tictactoe"),
        new(GameKeys.PoRacer, "Racer", "🏎️", "/poracer"),
        new(GameKeys.PoMarbleRace, "Marble Race", "🔮", "/pomarblerace"),
        new(GameKeys.PoBrawl, "Brawl", "🥊", "/pobrawl"),
    ];

    public static readonly IReadOnlyList<CatalogGame> LocalTwoPlayer =
    [
        new(GameKeys.ConnectFive, "Connect Five", "🔴", "/connectfive?mode=2p"),
        new(GameKeys.TicTacToe, "Tic-Tac-Toe", "❌", "/tictactoe?mode=2p"),
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
        new(GameKeys.TicTacToe, "Tic-Tac-Toe", "❌", "/tictactoe/1"),
        new(GameKeys.ConnectFive, "Connect Five", "🔴", "/connectfive/1"),
        new(GameKeys.PoRacer, "Racer", "🏎️", "/poracer/demo"),
        new(GameKeys.PoMarbleRace, "Marble Race", "🔮", "/pomarblerace?demo=1"),
        new(GameKeys.PoJoker, "Joker", "🃏", "/pojoker"),
        new(GameKeys.PoBrawl, "Brawl", "🥊", "/pobrawl/1"),
        new(GameKeys.PoSurvive, "Survive", "🛡️", "/posurvive?demo=1"),
    ];
}
