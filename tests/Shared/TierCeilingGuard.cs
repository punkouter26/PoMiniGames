using System.Reflection;
using FluentAssertions;
using Xunit;

namespace PoMiniGames.TestUtilities;

/// <summary>
/// Structural guardrail enforcing the ecosystem "100/50/25/25 Rule". Each test tier
/// derives one sealed, empty subclass naming its own ceiling; the assertion itself
/// lives here exactly once.
/// </summary>
/// <remarks>
/// <para>
/// We count <b>methods</b>, not discovered cases — a <c>[Theory]</c> with N inline rows
/// is one maintenance surface, not N. <see cref="TheoryAttribute"/> derives from
/// <see cref="FactAttribute"/>, so the single <c>FactAttribute</c> probe below captures
/// both (the four per-tier copies this replaced each tested for Theory separately, which
/// was always redundant).
/// </para>
/// <para>
/// If this fails, do <b>not</b> raise the cap — consolidate two facts into one theory, or
/// relocate the test to a cheaper tier. The cap is the point.
/// </para>
/// <para>
/// Guard subclasses are excluded from their own count: the <c>[Fact]</c> is declared here
/// on the abstract base, so <c>DeclaredOnly</c> would already skip it, and the
/// <see cref="TierCeilingGuard"/> assignability filter keeps that true even if a subclass
/// ever declares a test of its own.
/// </para>
/// </remarks>
public abstract class TierCeilingGuard
{
    /// <summary>Maximum test methods this tier may declare.</summary>
    protected abstract int Ceiling { get; }

    /// <summary>Tier name as it appears in the rule, used only in the failure message.</summary>
    protected abstract string TierName { get; }

    /// <summary>Where overflow from this tier should go instead of a raised cap.</summary>
    protected abstract string OverflowAdvice { get; }

    [Fact]
    public void Tier_StaysWithinCeiling()
    {
        var testMethodCount = GetType().Assembly
            .GetTypes()
            .Where(t => !typeof(TierCeilingGuard).IsAssignableFrom(t))
            .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            .Count(m => m.GetCustomAttributes<FactAttribute>(inherit: true).Any());

        testMethodCount.Should().BeLessThanOrEqualTo(
            Ceiling,
            because: $"the {TierName} tier is capped at {Ceiling} test methods by the 100/50/25/25 rule; " +
                     $"{OverflowAdvice} rather than raising the cap");
    }
}
