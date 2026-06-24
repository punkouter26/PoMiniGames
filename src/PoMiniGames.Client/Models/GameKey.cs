namespace PoMiniGamesClient.Models;

/// <summary>
/// Strongly-typed identifier for a game in the catalog. Replaces raw <see cref="string"/>
/// keys ("poclick", "connectfive", …) that were compared ad-hoc across the client, where a
/// typo compiled cleanly and failed only at runtime.
/// </summary>
/// <remarks>
/// Implicit conversions to/from <see cref="string"/> are provided so existing render sites
/// (string interpolation, attribute binding) keep working, while definition sites and
/// comparisons can use the named <see cref="GameKeys"/> instances for compile-time safety.
/// Equality is ordinal and case-insensitive to match how the keys were historically compared.
/// </remarks>
public readonly record struct GameKey(string Value)
{
    public bool Equals(GameKey other) =>
        string.Equals(Value, other.Value, StringComparison.OrdinalIgnoreCase);

    public override int GetHashCode() =>
        StringComparer.OrdinalIgnoreCase.GetHashCode(Value ?? string.Empty);

    public override string ToString() => Value;

    public static implicit operator string(GameKey key) => key.Value;
    public static implicit operator GameKey(string value) => new(value);
}

/// <summary>The canonical set of game keys. Reference these instead of magic string literals.</summary>
public static class GameKeys
{
    public static readonly GameKey PoClick = new("poclick");
    public static readonly GameKey ConnectFive = new("connectfive");
    public static readonly GameKey TicTacToe = new("tictactoe");
    public static readonly GameKey VoxelShooter = new("voxelshooter");
    public static readonly GameKey PoFight = new("pofight");
    public static readonly GameKey PoDropSquare = new("podropsquare");
    public static readonly GameKey PoBabyTouch = new("pobabytouch");
    public static readonly GameKey PoRaceRagdoll = new("poraceragdoll");
    public static readonly GameKey PoSnakeGame = new("posnakegame");
    public static readonly GameKey PoHorseRace = new("pohorserace");
    public static readonly GameKey PoRunner = new("porunner");
    public static readonly GameKey PoRacer = new("poracer");
    public static readonly GameKey PoMarbleRace = new("pomarblerace");
    public static readonly GameKey PoSurvive = new("posurvive");
    public static readonly GameKey PoCoupleQuiz = new("pocouplequiz");
    public static readonly GameKey PoFunQuiz = new("pofunquiz");
    public static readonly GameKey PoFace = new("poface");
    public static readonly GameKey PoJoker = new("pojoker");
}
