using System.Reflection;
using FluentAssertions;
using Xunit;

namespace PoMiniGames.E2EAPI;

/// <summary>
/// Structural guardrail enforcing the ecosystem "100/50/25/25 Rule": the
/// E2E-API tier is capped at 25 test methods. This keeps the in-process HTTP
/// contract suite from sprawling into Tier-1-shaped redundancy or Tier-4
/// browser-driven coverage.
/// </summary>
public sealed class E2EApiTestCountCeilingTests
{
    private const int E2EApiTierCeiling = 25;

    [Fact]
    public void E2EApiTier_StaysWithinCeiling()
    {
        var testMethodCount = Assembly.GetExecutingAssembly()
            .GetTypes()
            .Where(t => t != typeof(E2EApiTestCountCeilingTests))
            .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            .Count(m => m.GetCustomAttributes<FactAttribute>(inherit: true).Any()
                     || m.GetCustomAttributes<Xunit.TheoryAttribute>(inherit: true).Any());

        testMethodCount.Should().BeLessThanOrEqualTo(
            E2EApiTierCeiling,
            because: $"the E2E-API tier is capped at {E2EApiTierCeiling} test methods by the 100/50/25/25 rule; " +
                     "consolidate or move overflow to the Unit or Integration tier rather than raising the cap");
    }
}