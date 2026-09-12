using PoMiniGames.TestUtilities;

namespace PoMiniGames.Unit;

/// <summary>Unit tier ceiling. Assertion lives in <see cref="TierCeilingGuard"/>.</summary>
public sealed class TestCountCeilingTests : TierCeilingGuard
{
    protected override int Ceiling => 100;
    protected override string TierName => "Unit";
    protected override string OverflowAdvice =>
        "consolidate, or move overflow to the Integration tier,";
}
