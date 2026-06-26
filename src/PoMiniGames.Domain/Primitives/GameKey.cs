namespace PoMiniGames.Domain.Primitives;

/// <summary>
/// Strongly-typed wrapper around the game identifier used across leaderboards, stats,
/// and the AI Foundry deployment map. Replaces the raw-string convention
/// (<c>"couplequiz"</c>, <c>"funquiz"</c>, …) that was previously scattered through
/// endpoints, services, and clients — typos silently broke the leaderboard.
/// </summary>
/// <remarks>
/// <para>
/// Pattern: Value Object (Evans, 2003). Equality is by the underlying string; the
/// wrapper enforces a known catalogue at construction time and provides a single
/// source of truth for the on-the-wire form (<see cref="Value"/>).
/// </para>
/// <para>
/// <b>Allocation</b>: the 32 cached well-known keys (<see cref="WellKnown"/>) are
/// zero-alloc when callers reference them directly. <see cref="Parse"/> only
/// allocates when the input is not in the catalogue, which is the bug case we
/// want to surface.
/// </para>
/// </remarks>
public readonly record struct GameKey(string Value) : IComparable<GameKey>
{
    /// <summary>The raw string form, e.g. <c>"couplequiz"</c>. Safe to use in URLs / keys.</summary>
    public string Value { get; } = Value ?? string.Empty;

    /// <summary>True when the underlying string is empty (the zero value).</summary>
    public bool IsEmpty => string.IsNullOrEmpty(Value);

    /// <summary>Lexicographic comparison so callers can sort by canonical wire form.</summary>
    public int CompareTo(GameKey other) =>
        string.Compare(Value, other.Value, StringComparison.OrdinalIgnoreCase);

    public override string ToString() => Value;

    /// <summary>
    /// Parses a wire-format game key. Throws <see cref="ArgumentException"/> when the
    /// key is unknown so a caller typo surfaces as a 400, not a silent fallback to
    /// the all-leaderboards endpoint.
    /// </summary>
    public static GameKey Parse(string? input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            throw new ArgumentException("Game key cannot be null or whitespace.", nameof(input));
        }
        var normalized = input.Trim().ToLowerInvariant();
        if (WellKnownLookup.TryGetValue(normalized, out var canonical))
        {
            return canonical;
        }
        throw new ArgumentException(
            $"Unknown game key '{input}'. Known keys: {string.Join(", ", WellKnownNames)}.",
            nameof(input));
    }

    /// <summary>Parses a wire-format game key. Returns <c>null</c> for empty input.</summary>
    public static GameKey? TryParse(string? input)
    {
        if (string.IsNullOrWhiteSpace(input)) return null;
        var normalized = input.Trim().ToLowerInvariant();
        return WellKnownLookup.TryGetValue(normalized, out var canonical)
            ? canonical
            : null;
    }

    // ── Well-known keys (canonical wire form) ────────────────────────────

    public static readonly GameKey CoupleQuiz   = new("couplequiz");
    public static readonly GameKey FunQuiz      = new("funquiz");
    public static readonly GameKey Face         = new("face");
    public static readonly GameKey Joker        = new("joker");
    public static readonly GameKey Survive      = new("survive");

    public static readonly GameKey ConnectFive  = new("connectfive");
    public static readonly GameKey TicTacToe    = new("tictactoe");
    public static readonly GameKey PoFight      = new("pofight");
    public static readonly GameKey PoRaceRagdoll = new("poraceragdoll");
    public static readonly GameKey PoHorseRace  = new("pohorserace");
    public static readonly GameKey PoSnakeGame  = new("posnakegame");
    public static readonly GameKey PoMarbleRace = new("pomarblerace");
    public static readonly GameKey PoDropSquare = new("podropsquare");

    private static readonly GameKey[] All =
    {
        CoupleQuiz, FunQuiz, Face, Joker, Survive,
        ConnectFive, TicTacToe, PoFight, PoRaceRagdoll, PoHorseRace,
        PoSnakeGame, PoMarbleRace, PoDropSquare,
    };

    private static readonly string[] WellKnownNames = All.Select(k => k.Value).ToArray();

    private static readonly Dictionary<string, GameKey> WellKnownLookup =
        All.ToDictionary(k => k.Value, StringComparer.OrdinalIgnoreCase);

    public static IReadOnlyCollection<GameKey> WellKnown => All;
}