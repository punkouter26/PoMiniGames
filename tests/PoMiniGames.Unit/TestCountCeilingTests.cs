using PoMiniGames.TestUtilities;

namespace PoMiniGames.Unit;

/// <summary>Unit tier ceiling. Assertion lives in <see cref="TierCeilingGuard"/>.</summary>
public sealed class TestCountCeilingTests : TierCeilingGuard
{
    // Back to 100 on 2026-10-17 (it was 140 while the PoMule rules engine was written): a class
    // folds its one-off facts into a single Scenario theory, one row each (see Scenarios.cs).
    protected override int Ceiling => 100;
    protected override string TierName => "Unit";
    protected override string OverflowAdvice =>
        "fold facts into the class's Scenario theory (see Scenarios.cs), or move overflow to the Integration tier,";
}
