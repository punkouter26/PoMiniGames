// filepath: tests/PoMiniGames.Unit/AI/JevGateTests.cs
using FluentAssertions;
using PoMiniGames.AI;

namespace PoMiniGames.Unit.AI;

/// <summary>
/// Pins the threshold maths every Jev gate relies on (PoJoker, PoEcosystem).
/// If these cases drift, the gates either spend too freely (cost) or skip too
/// often (quality), and there is no obvious failure surface — both endpoints
/// return 200 OK in either branch. Catching the rule here is what makes the
/// "§Jev" comment on those gates load-bearing.
/// </summary>
public sealed class JevGateTests
{
    [Theory]
    [InlineData(0.10, 0.95, 0.65, true, "low noul, high confidence — skip")]
    [InlineData(0.50, 0.95, 0.65, true, "mid noul, high confidence — skip")]
    [InlineData(0.65, 0.95, 0.65, false, "noul exactly at threshold — spend")]
    [InlineData(0.90, 0.95, 0.65, false, "high noul — spend")]
    [InlineData(0.10, 0.40, 0.65, false, "low noul but low confidence — fall through (spend)")]
    [InlineData(0.90, 0.40, 0.65, false, "high noul but low confidence — spend anyway")]
    public void ShouldSkip_matches_calibrated_rule(double noul, double confidence, double threshold, bool expectedSkip, string _)
    {
        var decision = new JevDecision<double>(noul, confidence, FailingThrough: false);
        JevGate.ShouldSkip(decision, threshold).Should().Be(expectedSkip);
    }

    [Fact]
    public void Bypass_always_falls_through_regardless_of_threshold()
    {
        // A bypass happens when Jev is unconfigured, errors out, or is short-circuited.
        // The caller MUST see FallingThrough=true and treat it as "behave as if the gate
        // never existed". This is the entire reason bypass sets Value=0d and Confidence=0d:
        // a stray `if (decision.Confidence > 0.7)` guard would otherwise reject bypass as
        // "low confidence, skip" — wrong branch.
        var bypass = JevDecision<double>.Bypass();
        bypass.FailingThrough.Should().BeTrue();
        JevGate.ShouldSkip(bypass, threshold: 0.99).Should().BeFalse("bypass must always fall through");
    }

    [Fact]
    public void Default_min_confidence_matches_the_two_call_sites()
    {
        // Both call sites use the default 0.70 confidence floor. Pin the default here so
        // a future change is a conscious edit, not a silent shift.
        var decision = new JevDecision<double>(Value: 0.10, Confidence: 0.69, FailingThrough: false);
        JevGate.ShouldSkip(decision, threshold: 0.65).Should().BeFalse(
            "confidence just under the default floor must fall through, not skip");
    }
}
