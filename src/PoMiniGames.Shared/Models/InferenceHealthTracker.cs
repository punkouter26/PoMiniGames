namespace PoMiniGames.Shared.Simulation.Models;

/// <summary>
/// Rolling health of whatever provider is currently answering inference calls, so the UI can
/// stop claiming "AI online" once the answers stop arriving.
/// </summary>
/// <remarks>
/// <para>
/// Provider status used to be decided exactly once, at bootstrap: <c>/api/infer/status</c> said
/// the relay was available, the store recorded <c>REMOTE</c>, and the header pill went green and
/// stayed green. A measured 75-second session then issued 15 relay calls, completed none of them,
/// and put every agent on the trait-hash fallback table — under a green "AI online" chip, with the
/// Decision Inspector narrating the fallback's choice as though a model had reasoned about it.
/// </para>
/// <para>
/// One failure is not an outage (a single slow turn is normal), so degradation is keyed off
/// consecutive failures rather than any single one, and a success clears the streak immediately —
/// the provider recovering must be as visible as it failing. Lives in PoShared because the client
/// tracks per-agent call outcomes and the server tracks relay outcomes, and both should classify
/// "degraded" the same way.
/// </para>
/// </remarks>
public sealed class InferenceHealthTracker
{
    /// <summary>Consecutive failures before the provider is considered degraded.</summary>
    public const int DefaultFailureThreshold = 3;

    private readonly int _failureThreshold;
    private readonly object _gate = new();
    private int _consecutiveFailures;

    public InferenceHealthTracker(int failureThreshold = DefaultFailureThreshold)
        => _failureThreshold = Math.Max(1, failureThreshold);

    /// <summary>Failed calls since the last success.</summary>
    public int ConsecutiveFailures
    {
        get { lock (_gate) { return _consecutiveFailures; } }
    }

    /// <summary>True once the failure streak reaches the threshold. Cleared by any success.</summary>
    public bool IsDegraded
    {
        get { lock (_gate) { return _consecutiveFailures >= _failureThreshold; } }
    }

    /// <summary>Total failures observed for the lifetime of this tracker (diagnostics only).</summary>
    public int TotalFailures { get; private set; }

    /// <summary>Total successful calls observed for the lifetime of this tracker.</summary>
    public int TotalSuccesses { get; private set; }

    public void RecordSuccess()
    {
        lock (_gate)
        {
            _consecutiveFailures = 0;
            TotalSuccesses++;
        }
    }

    public void RecordFailure()
    {
        lock (_gate)
        {
            _consecutiveFailures++;
            TotalFailures++;
        }
    }

    /// <summary>Forgets all history — used when the player switches provider.</summary>
    public void Reset()
    {
        lock (_gate)
        {
            _consecutiveFailures = 0;
            TotalFailures = 0;
            TotalSuccesses = 0;
        }
    }
}
