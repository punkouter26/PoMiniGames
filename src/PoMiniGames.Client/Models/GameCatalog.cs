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
        new(GameKeys.PoClick, "PoClick", "🥁", "/poclick"),
        new(GameKeys.ConnectFive, "Connect Five", "🔴", "/connectfive"),
        new(GameKeys.TicTacToe, "Tic Tac Toe", "❌", "/tictactoe"),
        new(GameKeys.PoRunner, "PoRunner", "⚡", "/porunner?mode=1p"),
        new(GameKeys.PoRacer, "PoRacer", "🏎️", "/poracer"),
        new(GameKeys.PoMarbleRace, "PoMarbleRace", "🔮", "/pomarblerace"),
        new(GameKeys.PoSurvive, "PoSurvive", "🛡️", "/posurvive"),
        new(GameKeys.PoCoupleQuiz, "PoCoupleQuiz", "💕", "/couplequiz"),
        new(GameKeys.PoFunQuiz, "PoFunQuiz", "🧠", "/funquiz"),
        new(GameKeys.PoFace, "PoFace", "🙂", "/face"),
        new(GameKeys.PoBrawl, "PoBrawl", "🥊", "/pobrawl"),
    ];

    public static readonly IReadOnlyList<CatalogGame> LocalTwoPlayer =
    [
        new(GameKeys.ConnectFive, "Connect Five", "🔴", "/connectfive?mode=2p"),
        new(GameKeys.TicTacToe, "Tic Tac Toe", "❌", "/tictactoe?mode=2p"),
        new(GameKeys.PoRunner, "PoRunner", "⚡", "/porunner?mode=2p"),
        new(GameKeys.PoFunQuiz, "PoFunQuiz", "🧠", "/funquiz"),
        new(GameKeys.PoBrawl, "PoBrawl", "🥊", "/pobrawl?mode=2p"),
    ];

    public static readonly IReadOnlyList<CatalogGame> Multiplayer =
    [
        new(GameKeys.PoRunner, "PoRunner", "⚡", "/porunner/multi"),
        new(GameKeys.PoRacer, "PoRacer", "🏎️", "/poracer/lobby"),
        new(GameKeys.PoCoupleQuiz, "PoCoupleQuiz", "💕", "/couplequiz/lobby"),
        new(GameKeys.PoFunQuiz, "PoFunQuiz", "🧠", "/funquiz/multiplayer"),
    ];

    public static readonly IReadOnlyList<CatalogGame> Demo =
    [
        new(GameKeys.PoClick, "PoClick", "🥁", "/poclick/1"),
        new(GameKeys.TicTacToe, "Tic Tac Toe", "❌", "/tictactoe/1"),
        new(GameKeys.ConnectFive, "Connect Five", "🔴", "/connectfive/1"),
        new(GameKeys.PoCoupleQuiz, "PoCoupleQuiz", "💕", "/couplequiz?demo=1"),
        new(GameKeys.PoFace, "PoFace", "🙂", "/face/demo"),
        new(GameKeys.PoRunner, "PoRunner", "⚡", "/porunner/demo"),
        new(GameKeys.PoRacer, "PoRacer", "🏎️", "/poracer/demo"),
        new(GameKeys.PoMarbleRace, "PoMarbleRace", "🔮", "/pomarblerace?demo=1"),
        new(GameKeys.PoJoker, "PoJoker", "🃏", "/pojoker"),
        new(GameKeys.PoBrawl, "PoBrawl", "🥊", "/pobrawl/1"),
        new(GameKeys.PoSurvive, "PoSurvive", "🛡️", "/posurvive?demo=1"),
    ];
}
