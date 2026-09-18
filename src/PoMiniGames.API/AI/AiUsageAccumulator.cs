using System.Collections.Concurrent;

namespace PoMiniGames.AI;

/// <summary>
/// Process-local running totals of model usage per game, so the cost and health of the AI path
/// is queryable at runtime instead of only inferable from log archaeology.
/// </summary>
/// <remarks>
/// Deliberately in-memory and single-instance, matching every other registry in this host
/// (PoRacer's race registry, the FunQuiz lobby). It is a diagnostics read-model, not billing:
/// the authoritative numbers are the per-call log lines that Application Insights ingests.
/// </remarks>
public sealed class AiUsageAccumulator
{
    private readonly ConcurrentDictionary<string, Counters> _byGame = new(StringComparer.OrdinalIgnoreCase);

    /// <param name="Deployment">Deployment that served the most recent call for this game.</param>
    /// <param name="Calls">Successful calls.</param>
    /// <param name="Failures">Calls that threw (timeouts, circuit-open, service errors).</param>
    /// <param name="TotalTokens">Sum of reported total tokens across successful calls.</param>
    /// <param name="TotalLatencyMs">Sum of per-attempt latency across successful calls.</param>
    /// <param name="InputTokens">Sum of input tokens (prompt side).</param>
    /// <param name="OutputTokens">Sum of output tokens (completion side).</param>
    /// <param name="TotalCostUsd">Running USD total at <see cref="DeploymentPricing.Catalog"/> list prices.</param>
    public sealed record Counters(
        string Deployment,
        long Calls,
        long Failures,
        long TotalTokens,
        long TotalLatencyMs,
        long InputTokens,
        long OutputTokens,
        double TotalCostUsd)
    {
        /// <summary>Mean successful-call latency, or 0 before the first success.</summary>
        public long AverageLatencyMs => Calls == 0 ? 0 : TotalLatencyMs / Calls;

        /// <summary>Mean tokens per successful call, or 0 before the first success.</summary>
        public long AverageTokens => Calls == 0 ? 0 : TotalTokens / Calls;

        /// <summary>Mean USD per successful call, or 0 before the first success.</summary>
        public double AverageCostUsd => Calls == 0 ? 0d : TotalCostUsd / Calls;
    }

    public void Record(string game, string deployment, long inputTokens, long outputTokens, long elapsedMs)
    {
        var total = inputTokens + outputTokens;
        var pricing = DeploymentPricing.For(deployment);
        var cost = pricing.CostUsd(inputTokens, outputTokens);

        _byGame.AddOrUpdate(
            game,
            _ => new Counters(deployment, 1, 0, total, elapsedMs, inputTokens, outputTokens, cost),
            (_, c) => c with
            {
                Deployment = deployment,
                Calls = c.Calls + 1,
                TotalTokens = c.TotalTokens + total,
                TotalLatencyMs = c.TotalLatencyMs + elapsedMs,
                InputTokens = c.InputTokens + inputTokens,
                OutputTokens = c.OutputTokens + outputTokens,
                TotalCostUsd = c.TotalCostUsd + cost,
            });
    }

    public void RecordFailure(string game, string deployment, long elapsedMs)
        => _byGame.AddOrUpdate(
            game,
            _ => new Counters(deployment, 0, 1, 0, elapsedMs, 0, 0, 0d),
            (_, c) => c with { Deployment = deployment, Failures = c.Failures + 1 });

    /// <summary>Snapshot for the diagnostics surface.</summary>
    public IReadOnlyDictionary<string, Counters> Snapshot()
        => _byGame.ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.OrdinalIgnoreCase);
}
