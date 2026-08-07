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

    private AiUsageScope(string? identity)
    {
        Identity = identity;
        _previous = Current.Value;
        Current.Value = this;
    }

    /// <summary>Opens a scope for the current async flow.</summary>
    public static AiUsageScope Begin() => new(null);

    /// <summary>
    /// Opens a scope that also names the caller the spend belongs to, so
    /// <see cref="BudgetedChatClient"/> can charge and refuse without every AI-consuming service
    /// having to thread an identity through its own interface.
    /// </summary>
    /// <remarks>
    /// The identity is carried on the scope rather than resolved at the decorator because the
    /// decorator is a singleton with no request context, and half the AI calls in this host do not
    /// originate from an HTTP request at all — PoCoupleQuiz's question generation and similarity
    /// scoring run inside SignalR hub invocations, where <c>IHttpContextAccessor</c> is unreliable.
    /// One ambient scope covers both entry points.
    /// </remarks>
    public static AiUsageScope Begin(string identity) => new(identity);

    /// <summary>
    /// Caller the spend inside this scope is charged to, or null when the scope only accumulates.
    /// </summary>
    public string? Identity { get; }

    /// <summary>The innermost open scope for the current async flow, if any.</summary>
    public static AiUsageScope? CurrentScope => Current.Value;

    /// <summary>
    /// Re-opens a scope for an identity captured earlier, for a callback that does not inherit the
    /// caller's <see cref="System.Threading.ExecutionContext"/>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>This is not a theoretical hazard.</b> <c>HybridCache.GetOrCreateAsync</c> does not run its
    /// factory on the calling flow — stampede protection means one caller's factory serves several
    /// waiters, so it cannot — and an <see cref="AsyncLocal{T}"/> set by the request middleware does
    /// not reach inside it. Measured against this host: two PoFunQuiz generation calls costing 809
    /// tokens were recorded by the telemetry and charged <b>zero</b> to the caller's daily
    /// allowance, because the endpoint invokes the generator through a cache factory. Every AI call
    /// behind a cache was silently uncapped.
    /// </para>
    /// <para>
    /// So a factory that can reach a model must carry the identity in its state and reopen the
    /// scope with it. Passing null is harmless — it produces a scope that accumulates but charges
    /// nobody, which is the same as having none.
    /// </para>
    /// </remarks>
    public static AiUsageScope Restore(string? identity) => new(identity);

    /// <summary>
    /// Identity of the innermost scope that names one. Falls back through the enclosing scopes so a
    /// nested bare <see cref="Begin()"/> does not shadow the identity an outer scope established.
    /// </summary>
    public static string? CurrentIdentity
    {
        get
        {
            for (var scope = Current.Value; scope is not null; scope = scope._previous)
            {
                if (!string.IsNullOrEmpty(scope.Identity))
                    return scope.Identity;
            }
            return null;
        }
    }

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
