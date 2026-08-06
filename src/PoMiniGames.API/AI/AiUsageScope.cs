namespace PoMiniGames.AI;

/// <summary>
/// Ambient collector for the token cost of the model calls made inside one logical operation —
/// so a request handler can charge a caller's budget the tokens the provider actually reported
/// rather than an estimate of them.
/// </summary>
/// <remarks>
/// <para>
/// The alternative was passing usage back through <c>IInferenceService</c>, which would put a
/// billing concern in the interface every provider (in-browser WebLLM included) has to implement,
/// or threading <c>HttpContext</c> into the chat-client decorators, which would couple them to
/// ASP.NET. An <see cref="AsyncLocal{T}"/> scope flows through the await chain of the one request
/// that opened it and touches neither. Same technique the client's
/// <c>WebLlmInferenceService.BeginDiagnosticsScope</c> already uses to correlate per-agent calls.
/// </para>
/// <para>Nesting is supported: an inner scope restores the outer one on dispose, and reports
/// accumulate into whichever scope is innermost at the time of the call.</para>
/// </remarks>
public sealed class AiUsageScope : IDisposable
{
    private static readonly AsyncLocal<AiUsageScope?> Current = new();

    private readonly AiUsageScope? _previous;
    private long _totalTokens;
    private int _calls;
    private bool _disposed;

    private AiUsageScope()
    {
        _previous = Current.Value;
        Current.Value = this;
    }

    /// <summary>Opens a scope for the current async flow.</summary>
    public static AiUsageScope Begin() => new();

    /// <summary>Total tokens reported by providers inside this scope.</summary>
    public long TotalTokens => Interlocked.Read(ref _totalTokens);

    /// <summary>Number of model calls that reported usage inside this scope.</summary>
    public int Calls => Volatile.Read(ref _calls);

    /// <summary>Records a completed call's usage against the innermost open scope, if any.</summary>
    public static void Report(long totalTokens)
    {
        var scope = Current.Value;
        if (scope is null) return;
        Interlocked.Add(ref scope._totalTokens, Math.Max(0, totalTokens));
        Interlocked.Increment(ref scope._calls);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Current.Value = _previous;
    }
}
