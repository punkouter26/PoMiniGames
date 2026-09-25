// filepath: tests/PoMiniGames.Unit/AI/DeploymentPricingTests.cs
using FluentAssertions;
using PoMiniGames.AI;

namespace PoMiniGames.Unit.AI;

/// <summary>
/// Pins the USD per-token math the diagnostics surface reports. The numbers
/// here flow into /api/health/ai; if a per-deployment
/// price drifts in DeploymentPricing.Catalog, the diag row lies to the on-call
/// engineer about how much a runaway game is costing. The catalog is the
/// single source of truth — these cases pin both the catalog values for the
/// four deployments this codebase actually uses and the math that derives
/// per-call and aggregate USD from token counts.
/// </summary>
public sealed class DeploymentPricingTests
{
    [Theory]
    // (deployment, input, output, expected USD with 6 decimals).
    // Numbers are the listed 2026-Q3 prices.
    [InlineData("gpt-5.4-nano", 1_000_000, 1_000_000, 0.50)]   // 0.10 + 0.40
    [InlineData("gpt-5.4-nano", 100_000, 100_000, 0.05)]   // 10x smaller
    [InlineData("gpt-5-nano", 1_000_000, 1_000_000, 1.00)]   // 0.20 + 0.80
    [InlineData("gpt-5.4-mini", 1_000_000, 1_000_000, 2.00)]   // 0.40 + 1.60
    [InlineData("Phi-4-mini-instruct", 1_000_000, 1_000_000, 0.35)] // 0.07 + 0.28
    [InlineData("unknown-model", 1_000_000, 1_000_000, 0.0)]   // catalog miss → $0
    public void CostUsd_matches_listed_prices(string deployment, long inputTokens, long outputTokens, double expectedUsd)
    {
        var pricing = DeploymentPricing.For(deployment);
        var actual = pricing.CostUsd(inputTokens, outputTokens);
        actual.Should().BeApproximately(expectedUsd, 0.000001);
    }

    [Fact]
    public void Catalog_covers_every_deployment_and_degrades_safely()
    {
        // An empty deployment name falls through to the shared Unknown row rather than throwing.
        DeploymentPricing.For("").Should().BeSameAs(DeploymentPricing.Unknown);

        // Defensive: if a provider reports a negative number for any reason, the
        // diagnostic must not produce a negative cost row.
        DeploymentPricing.For("gpt-5.4-nano").CostUsd(-100, -100).Should().Be(0d);

        // If a deployment name leaks into the AiUsageAccumulator without a price,
        // /api/health/ai silently reports $0 for that row. Catch it at unit time
        // by pinning the names every game actually uses.
        var expected = new[]
        {
            "gpt-5.4-nano",
            "gpt-5-nano",
            "gpt-5.4-mini",
            "Phi-4-mini-instruct",
        };
        foreach (var d in expected)
        {
            DeploymentPricing.Catalog.Should().ContainKey(d,
                $"DeploymentPricing.Catalog must price {d} — without it, /api/health/ai reports $0 silently");
        }
    }
}
