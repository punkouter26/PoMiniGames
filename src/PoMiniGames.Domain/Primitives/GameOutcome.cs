namespace PoMiniGames.Domain.Primitives;

/// <summary>
/// Strongly-typed outcome of a single game. Replaces the loose string-equality
/// convention (<c>outcome?.Equals("win", OrdinalIgnoreCase)</c>) that silently
/// mapped "won" / "victory" / "W" to <see cref="Loss"/>.
/// </summary>
/// <remarks>
/// <para>
/// Pattern: Value Object + Closed Enum. The kind tags are exhaustive so the
/// compiler can verify every switch in the codebase; the parse rules capture
/// every legacy synonym at the boundary so callers downstream only ever see
/// one of the three canonical kinds.
/// </para>
/// </remarks>
public readonly record struct GameOutcome
{
    public enum Kind { Unknown = 0, Win = 1, Loss = 2, Draw = 3 }

    public Kind Value { get; }

    private GameOutcome(Kind value) => Value = value;

    public static readonly GameOutcome Unknown = new(Kind.Unknown);
    public static readonly GameOutcome Win     = new(Kind.Win);
    public static readonly GameOutcome Loss    = new(Kind.Loss);
    public static readonly GameOutcome Draw    = new(Kind.Draw);

    /// <summary>Parses legacy string synonyms. Unknown input maps to <see cref="Unknown"/>.</summary>
    public static GameOutcome Parse(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return Unknown;
        return raw.Trim().ToLowerInvariant() switch
        {
            "win" or "won" or "victory" or "w" => Win,
            "loss" or "lose" or "lost" or "l" => Loss,
            "draw" or "tie" or "d"            => Draw,
            _                                 => Unknown,
        };
    }

    public bool IsWin  => Value == Kind.Win;
    public bool IsLoss => Value == Kind.Loss;
    public bool IsDraw => Value == Kind.Draw;
    public bool IsKnown => Value != Kind.Unknown;

    public override string ToString() => Value switch
    {
        Kind.Win  => "win",
        Kind.Loss => "loss",
        Kind.Draw => "draw",
        _         => "unknown",
    };
}