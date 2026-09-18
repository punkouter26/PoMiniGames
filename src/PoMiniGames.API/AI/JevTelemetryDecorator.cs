// filepath: src/PoMiniGames.API/AI/JevTelemetryDecorator.cs
using System.Diagnostics;

namespace PoMiniGames.AI;

/// <summary>
/// Decorator over <see cref="IJevClient"/> that records every decision into
/// <see cref="JevUsageAccumulator"/>. Sits BETWEEN the caller and
/// <see cref="JevHttpClient"/> so the trace fires regardless of whether the
/// outcome was a real Jev call or a <see cref="JevDecision{T}.Bypass"/>.
///
/// <para>
/// <b>Why a decorator and not an instrumentation hook inside JevHttpClient?</b>
/// Some calls bypass before any HTTP round trip (empty criteria, key missing);
/// instrumenting inside <see cref="JevHttpClient"/> would miss those, and the
/// dev-facing <c>/api/health/jev</c> would under-report by exactly the failure
/// cases that matter for debugging. Decorating at the seam means every branch
/// the caller can possibly take is observable.
/// </para>
/// </summary>
public sealed class JevTelemetryDecorator : IJevClient
{
    private readonly IJevClient _inner;
    private readonly JevUsageAccumulator _usage;
    private readonly ILogger<JevTelemetryDecorator> _logger;

    public JevTelemetryDecorator(IJevClient inner, JevUsageAccumulator usage, ILogger<JevTelemetryDecorator> logger)
    {
        _inner = inner;
        _usage = usage;
        _logger = logger;
    }

    public async Task<JevDecision<double>> EvaluateNoulAsync(string instructions, object state, CancellationToken ct = default)
    {
        var sw = Stopwatch.StartNew();
        var result = await _inner.EvaluateNoulAsync(instructions, state, ct);
        sw.Stop();
        _usage.Record(GameForCaller(), "noul", JevCallOutcome.Noul,
            confidence: result.Confidence,
            chosenOption: null,
            latencyMs: sw.ElapsedMilliseconds,
            failingThrough: result.FailingThrough,
            inputTokens: JevInputEstimator.EstimateTokens(instructions, state));
        return result;
    }

    public async Task<JevDecision<string>> EvaluateChoiceAsync(string instructions, IReadOnlyDictionary<string, string> criteria, object state, CancellationToken ct = default)
    {
        var sw = Stopwatch.StartNew();
        var result = await _inner.EvaluateChoiceAsync(instructions, criteria, state, ct);
        sw.Stop();
        _usage.Record(GameForCaller(), "choice", JevCallOutcome.Choice,
            confidence: result.Confidence,
            chosenOption: result.Value,
            latencyMs: sw.ElapsedMilliseconds,
            failingThrough: result.FailingThrough,
            inputTokens: JevInputEstimator.EstimateTokens(instructions, state, criteria));
        return result;
    }

    public async Task<JevDecision<double>> EvaluateScoreAsync(string instructions, IReadOnlyDictionary<string, string> levels, object state, CancellationToken ct = default)
    {
        var sw = Stopwatch.StartNew();
        var result = await _inner.EvaluateScoreAsync(instructions, levels, state, ct);
        sw.Stop();
        _usage.Record(GameForCaller(), "score", JevCallOutcome.Score,
            confidence: result.Confidence,
            chosenOption: result.Value.ToString("0.##"),
            latencyMs: sw.ElapsedMilliseconds,
            failingThrough: result.FailingThrough,
            inputTokens: JevInputEstimator.EstimateTokens(instructions, state, levels));
        return result;
    }

    /// <summary>
    /// Best-effort game-key extraction from the ambient DI scope. The caller tags
    /// itself via <see cref="JevCallScope"/>; here we just pull the most recent
    /// scope name, falling back to "unknown" when the caller did not tag itself.
    /// </summary>
    private string GameForCaller() => JevCallScope.Current ?? "unknown";
}

/// <summary>
/// Ambient scope tag that callers set before invoking <see cref="IJevClient"/>
/// so <see cref="JevTelemetryDecorator"/> can bucket the call by game. Uses
/// <see cref="AsyncLocal{T}"/> so it flows through async/await without leaking
/// across requests on a shared thread.
/// </summary>
public static class JevCallScope
{
    private static readonly AsyncLocal<string?> _current = new();
    public static string? Current
    {
        get => _current.Value;
        set => _current.Value = value;
    }

    /// <summary>Set the current scope for the duration of the using block.</summary>
    public static IDisposable Push(string game)
    {
        var prior = _current.Value;
        _current.Value = game;
        return new Restore(prior);
    }

    private sealed class Restore : IDisposable
    {
        private readonly string? _prior;
        public Restore(string? prior) => _prior = prior;
        public void Dispose() => _current.Value = _prior;
    }
}
