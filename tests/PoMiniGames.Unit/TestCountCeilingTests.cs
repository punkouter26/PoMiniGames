using PoMiniGames.TestUtilities;

namespace PoMiniGames.Unit;

/// <summary>Unit tier ceiling. Assertion lives in <see cref="TierCeilingGuard"/>.</summary>
public sealed class TestCountCeilingTests : TierCeilingGuard
{
    // Raised from 100 on 2026-10-05: the PoMule rules engine is test-driven and the tier
    // was already full. See SPEC.md, decision 1.
    protected override int Ceiling => 140;
    protected override string TierName => "Unit";
    protected override string OverflowAdvice =>
        "consolidate, or move overflow to the Integration tier,";
}
