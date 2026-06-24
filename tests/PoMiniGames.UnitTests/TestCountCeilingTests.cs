using System.Reflection;
using FluentAssertions;
using Xunit;

namespace PoMiniGames.UnitTests;

/// <summary>
/// Structural guardrail enforcing the ecosystem "100/50/25/25 Rule": the Unit tier is
/// capped at 100 test methods. This keeps the hermetic, instantaneous tier from sprawling
/// into integration-shaped redundancy and flaky loops. xUnit's <see cref="TheoryAttribute"/>
/// derives from <see cref="FactAttribute"/>, so counting methods that carry a
/// <see cref="FactAttribute"/> captures both <c>[Fact]</c> and <c>[Theory]</c> methods.
/// </summary>
/// <remarks>
/// We count <b>methods</b>, not discovered cases (a <c>[Theory]</c> with N inline rows is
/// one maintenance surface, not N). If this fails, do not raise the cap — consolidate or
/// relocate tests to the integration tier instead.
/// </remarks>
public sealed class TestCountCeilingTests
{
    private const int UnitTierCeiling = 100;

    [Fact]
    public void UnitTier_StaysWithinCeiling()
    {
        var testMethodCount = Assembly.GetExecutingAssembly()
            .GetTypes()
            .Where(t => t != typeof(TestCountCeilingTests)) // the guard itself is not a product test
            .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            .Count(m => m.GetCustomAttributes<FactAttribute>(inherit: true).Any());

        testMethodCount.Should().BeLessThanOrEqualTo(
            UnitTierCeiling,
            because: $"the Unit tier is capped at {UnitTierCeiling} test methods by the 100/50/25/25 rule; " +
                     "consolidate or move overflow to the integration tier rather than raising the cap");
    }
}
