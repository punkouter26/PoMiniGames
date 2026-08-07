using Microsoft.Extensions.Options;

namespace PoMiniGames.AI;

/// <summary>
/// <c>GET /api/health/ai</c> — the runtime read-model of what the AI path is doing and costing.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="AiUsageAccumulator"/> documented itself as making the AI path "queryable at runtime
/// instead of only inferable from log archaeology", and then had no reader: <c>Snapshot()</c> was
/// called by nothing. Every call was recorded into a dictionary no one could see. This is that
/// reader.
/// </para>
/// <para>
/// Process-local and not authoritative — the figures reset on restart and are per-instance. The
/// billing truth is the per-call log lines Application Insights ingests; this answers "what is
/// happening right now, on this host" without a query.
/// </para>
/// </remarks>
public static class AiUsageEndpoints
{
    public static IEndpointRouteBuilder MapAiUsageEndpoints(this IEndpointRouteBuilder routes)
    {
        var group = routes.MapGroup("/api/health/ai").WithTags("Health");

        group.MapGet("", GetUsage)
             .WithName("AiUsage")
             .WithSummary("Per-game AI call counts, failures, token totals and latency for this process.")
             .Produces<AiUsageReportDto>(StatusCodes.Status200OK);

        return routes;
    }

    private static IResult GetUsage(
        AiUsageAccumulator usage,
        AiTokenBudget budget,
        IOptionsMonitor<AIFoundryOptions> options,
        HttpContext http)
    {
        var opts = options.CurrentValue;
        var snapshot = usage.Snapshot();

        var games = snapshot
            .OrderBy(kv => kv.Key, StringComparer.OrdinalIgnoreCase)
            .Select(kv => new AiGameUsageDto(
                Game: kv.Key,
                Deployment: kv.Value.Deployment,
                Calls: kv.Value.Calls,
                Failures: kv.Value.Failures,
                TotalTokens: kv.Value.TotalTokens,
                AverageTokens: kv.Value.AverageTokens,
                AverageLatencyMs: kv.Value.AverageLatencyMs))
            .ToList();

        // The caller's own allowance, so a player hitting the ceiling can be told why without
        // anyone reading a log. Only ever their own — this reports no other identity's spend.
        var identity = AiUsageScopeExtensions.ResolveIdentity(http);
        var verdict = budget.Check(identity);

        return Results.Ok(new AiUsageReportDto(
            Configured: opts.IsConfigured,
            Endpoint: opts.IsConfigured ? opts.Endpoint : null,
            DefaultDeployment: opts.DefaultDeployment,
            EmbeddingDeployment: string.IsNullOrWhiteSpace(opts.EmbeddingDeployment) ? null : opts.EmbeddingDeployment,
            Games: games,
            TotalCalls: games.Sum(g => g.Calls),
            TotalFailures: games.Sum(g => g.Failures),
            TotalTokens: games.Sum(g => g.TotalTokens),
            Budget: new AiBudgetDto(
                Unlimited: budget.IsUnlimited,
                Spent: verdict.Spent,
                Limit: verdict.Limit,
                Allowed: verdict.Allowed,
                ResetUtc: verdict.ResetUtc)));
    }
}

/// <param name="Configured">False when no foundry endpoint is set; games serve mocks or fail.</param>
/// <param name="Games">Per-game counters for this process. Empty before the first call.</param>
/// <param name="Budget">The calling identity's own daily token allowance.</param>
public sealed record AiUsageReportDto(
    bool Configured,
    string? Endpoint,
    string DefaultDeployment,
    string? EmbeddingDeployment,
    IReadOnlyList<AiGameUsageDto> Games,
    long TotalCalls,
    long TotalFailures,
    long TotalTokens,
    AiBudgetDto Budget);

/// <param name="Game">Game key, or <c>embed:&lt;purpose&gt;</c> for an embedding workload.</param>
/// <param name="Failures">Calls that threw — timeouts, circuit-open, service errors.</param>
public sealed record AiGameUsageDto(
    string Game,
    string Deployment,
    long Calls,
    long Failures,
    long TotalTokens,
    long AverageTokens,
    long AverageLatencyMs);

/// <param name="Unlimited">True when the daily ceiling is switched off.</param>
/// <param name="ResetUtc">Start of the next UTC day, when the allowance returns.</param>
public sealed record AiBudgetDto(
    bool Unlimited,
    long Spent,
    long Limit,
    bool Allowed,
    DateTimeOffset ResetUtc);
