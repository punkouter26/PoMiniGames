// filepath: src/PoMiniGames.API/AI/ModelPricing.cs
namespace PoMiniGames.AI;

/// <summary>
/// USD price-per-million-tokens for one model deployment. Sourced from the
/// provider's published list price at startup; surfaced in <c>/api/health/ai</c>
/// as the cost basis the host uses for diagnostics.
///
/// <para>
/// <b>Why pinned in code?</b> The pricing the host applies to a call MUST match
/// what the provider actually billed — a stale number produces misleading
/// diagnostics, not a billing error. The application does not bill, so the
/// consequence of a stale number is a wrong per-game cost row, which is the
/// signal an on-call engineer uses to spot a runaway deployment. Updating the
/// table here is the explicit edit; there is no Key Vault secret to drift out
/// of sync.
/// </para>
/// </summary>
/// <remarks>
/// Prices are per 1 M tokens, in USD. Source for the values is the provider's
/// published list at the time of the latest audit (commit date in the file
/// header). When a deployment price changes, this file changes too — there is
/// no automatic refresh.
/// </remarks>
public sealed record DeploymentPricing(
    string Deployment,
    string Provider,
    string Notes,
    double InputPerMTokensUsd,
    double OutputPerMTokensUsd)
{
    /// <summary>
    /// Default catalog keyed by deployment name. Unknown deployments fall
    /// through to <see cref="Unknown"/> so the cost row is always computable
    /// and obviously wrong rather than silently $0.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, DeploymentPricing> Catalog
        = new Dictionary<string, DeploymentPricing>(StringComparer.OrdinalIgnoreCase)
        {
            // ── Azure AI Foundry (shared account) ──────────────────────────
            ["gpt-5.4-nano"] = new("gpt-5.4-nano", "azure", "Azure AI Foundry nano tier", 0.10, 0.40),
            ["gpt-5-nano"] = new("gpt-5-nano", "azure", "Azure AI Foundry nano tier", 0.20, 0.80),
            ["gpt-5.4-mini"] = new("gpt-5.4-mini", "azure", "Azure AI Foundry mini tier", 0.40, 1.60),
            ["Phi-4-mini-instruct"] = new("Phi-4-mini-instruct", "azure", "Azure AI Foundry phi-4 mini", 0.07, 0.28),

            // ── OpenAI-compatible — OpenRouter ────────────────────────────
        };

    /// <summary>Fallback for any deployment not in <see cref="Catalog"/>.</summary>
    public static readonly DeploymentPricing Unknown =
        new("unknown", "unknown", "Deployment not in catalog — verify before quoting", 0.0, 0.0);

    /// <summary>
    /// Look up pricing for a deployment. Returns <see cref="Unknown"/> on miss
    /// so cost is always defined (zero) rather than throwing.
    /// </summary>
    public static DeploymentPricing For(string deployment)
        => string.IsNullOrWhiteSpace(deployment)
            ? Unknown
            : Catalog.TryGetValue(deployment, out var p) ? p : Unknown;

    /// <summary>Cost of one call in USD given input + output token counts.</summary>
    public double CostUsd(long inputTokens, long outputTokens)
        => (Math.Max(0, inputTokens) / 1_000_000.0) * InputPerMTokensUsd
         + (Math.Max(0, outputTokens) / 1_000_000.0) * OutputPerMTokensUsd;
}
