using System.Reflection;
using FluentAssertions;
using Xunit;

namespace PoMiniGames.E2EUI;

/// <summary>
/// Structural guardrail enforcing the ecosystem "100/50/25/25 Rule": the
/// E2E-UI tier is capped at 25 test methods. This keeps the
/// browser-driven Chromium suite (the most expensive tier — real WASM cold
/// boot, real network, real Kestrel) from sprawling and stealing time from
/// Tier-1 unit tests that can cover the same surface area in milliseconds.
/// </summary>
public sealed class E2EUiTestCountCeilingTests
{
    private const int E2EUiTierCeiling = 25;

    [Fact]
    public void E2EUiTier_StaysWithinCeiling()
    {
        var testMethodCount = Assembly.GetExecutingAssembly()
            .GetTypes()
            .Where(t => t != typeof(E2EUiTestCountCeilingTests))
            .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            .Count(m => m.GetCustomAttributes<FactAttribute>(inherit: true).Any()
                     || m.GetCustomAttributes<Xunit.TheoryAttribute>(inherit: true).Any());

        testMethodCount.Should().BeLessThanOrEqualTo(
            E2EUiTierCeiling,
            because: $"the E2E-UI tier is capped at {E2EUiTierCeiling} test methods by the 100/50/25/25 rule; " +
                     "consolidate or move overflow to a cheaper tier rather than raising the cap");
    }
}