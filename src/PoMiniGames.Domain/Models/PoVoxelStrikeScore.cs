namespace PoMiniGames.Domain.Models;

/// <summary>
/// A PoVoxelStrike run score that cannot exist outside its legal range. Parsing an
/// untrusted <see cref="int"/> into this type is the only way to obtain one, so the range
/// rule lives with the value instead of being re-checked (or forgotten) at each call site.
/// </summary>
/// <remarks>
/// <see cref="Max"/> is a sanity ceiling, not a bound on real play: the formula is
/// <c>seconds×10 + kills×25 + bruteBonus×50 + crushBonus×40 + voxels÷20</c>, so a
/// multi-hour god run still lands far below it. It exists to reject a tampered submission
/// (<c>int.MaxValue</c>) that would otherwise own the board forever. The endpoint layers a
/// tighter plausibility check on top (score vs. the run stats submitted with it).
/// </remarks>
public readonly record struct PoVoxelStrikeScore
{
    public const int Min = 0;
    public const int Max = 10_000_000;

    private PoVoxelStrikeScore(int value) => Value = value;

    public int Value { get; }

    public static bool TryCreate(int value, out PoVoxelStrikeScore score)
    {
        score = default;
        if (value is < Min or > Max) return false;
        score = new PoVoxelStrikeScore(value);
        return true;
    }

    /// <summary>Parses a trusted value (one already persisted, or produced in-process).</summary>
    public static PoVoxelStrikeScore Clamp(int value) => new(Math.Clamp(value, Min, Max));

    public static implicit operator int(PoVoxelStrikeScore score) => score.Value;

    public override string ToString() => Value.ToString();
}
