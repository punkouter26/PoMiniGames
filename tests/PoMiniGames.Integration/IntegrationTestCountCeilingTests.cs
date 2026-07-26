using System.Reflection;
using FluentAssertions;
using Xunit;

namespace PoMiniGames.Integration;

/// <summary>
/// Structural guardrail enforcing the ecosystem "100/50/25/25 Rule": the
/// Integration tier is capped at 50 test methods. This keeps the Tier-2 suite
/// (WebApplicationFactory + Azurite Testcontainers) from sprawling into
/// Tier-1-shaped redundancy or Tier-3 E2E-API contracts.
/// </summary>
/// <remarks>
/// We count <b>methods</b>, not discovered cases (a <c>[Theory]</c> with N
/// inline rows is one maintenance surface, not N). If this fails, do not raise
/// the cap — consolidate or relocate tests to the Unit or E2E-API tier instead.
/// </remarks>
public sealed class IntegrationTestCountCeilingTests
{
    private const int IntegrationTierCeiling = 50;

    [Fact]
    public void IntegrationTier_StaysWithinCeiling()
    {
        var testMethodCount = Assembly.GetExecutingAssembly()
            .GetTypes()
            .Where(t => t != typeof(IntegrationTestCountCeilingTests))
            .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            .Count(m => m.GetCustomAttributes<FactAttribute>(inherit: true).Any()
                     || m.GetCustomAttributes<Xunit.TheoryAttribute>(inherit: true).Any());

        testMethodCount.Should().BeLessThanOrEqualTo(
            IntegrationTierCeiling,
            because: $"the Integration tier is capped at {IntegrationTierCeiling} test methods by the 100/50/25/25 rule; " +
                     "consolidate or move overflow to the Unit or E2E-API tier rather than raising the cap");
    }
}
