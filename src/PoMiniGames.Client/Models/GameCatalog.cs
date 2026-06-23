namespace PoMiniGamesClient.Models;

/// <summary>A single game entry shown under a home-page section.</summary>
public sealed record CatalogGame(string Key, string Title, string Icon, string Url);

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
        new("poclick", "PoClick", "🥁", "/poclick"),
        new("connectfive", "Connect Five", "🔴", "/connectfive"),
        new("tictactoe", "Tic Tac Toe", "❌", "/tictactoe"),
        new("voxelshooter", "Voxel Shooter", "🎯", "/voxelshooter"),
        new("pofight", "PoFight", "⚔️", "/pofight"),
        new("podropsquare", "PoDropSquare", "⬜", "/podropsquare"),
        new("pobabytouch", "PoBabyTouch", "👶", "/pobabytouch"),
        new("poraceragdoll", "PoRaceRagdoll", "🚗", "/poraceragdoll"),
        new("posnakegame", "PoSnakeGame", "🐍", "/posnakegame"),
        new("pohorserace", "PoHorseRace", "🏇", "/pohorserace"),
        new("porunner", "PoRunner", "⚡", "/porunner?mode=1p"),
        new("poracer", "PoRacer", "🏎️", "/poracer"),
        new("pomarblerace", "PoMarbleRace", "🔮", "/pomarblerace"),
        new("posurvive", "PoSurvive", "🛡️", "/posurvive"),
        new("pocouplequiz", "PoCoupleQuiz", "💕", "/couplequiz"),
        new("pofunquiz", "PoFunQuiz", "🧠", "/funquiz"),
        new("poface", "PoFace", "🙂", "/face"),
    ];

    public static readonly IReadOnlyList<CatalogGame> LocalTwoPlayer =
    [
        new("connectfive", "Connect Five", "🔴", "/connectfive?mode=2p"),
        new("tictactoe", "Tic Tac Toe", "❌", "/tictactoe?mode=2p"),
        new("porunner", "PoRunner", "⚡", "/porunner?mode=2p"),
        new("pofunquiz", "PoFunQuiz", "🧠", "/funquiz"),
    ];

    public static readonly IReadOnlyList<CatalogGame> Multiplayer =
    [
        new("porunner", "PoRunner", "⚡", "/porunner/multi"),
        new("poracer", "PoRacer", "🏎️", "/poracer/lobby"),
        new("pocouplequiz", "PoCoupleQuiz", "💕", "/couplequiz/lobby"),
        new("pofunquiz", "PoFunQuiz", "🧠", "/funquiz/multiplayer"),
    ];

    public static readonly IReadOnlyList<CatalogGame> Demo =
    [
        new("poclick", "PoClick", "🥁", "/poclick/1"),
        new("tictactoe", "Tic Tac Toe", "❌", "/tictactoe/1"),
        new("connectfive", "Connect Five", "🔴", "/connectfive/1"),
        new("pofight", "PoFight", "⚔️", "/pofight/1"),
        new("poraceragdoll", "PoRaceRagdoll", "🚗", "/poraceragdoll?demo=1"),
        new("pohorserace", "PoHorseRace", "🏇", "/pohorserace?demo=1"),
        new("porunner", "PoRunner", "⚡", "/porunner/demo"),
        new("poracer", "PoRacer", "🏎️", "/poracer/demo"),
        new("pomarblerace", "PoMarbleRace", "🔮", "/pomarblerace?demo=1"),
    ];
}
