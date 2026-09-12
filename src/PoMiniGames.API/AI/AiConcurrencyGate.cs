using System.Threading.RateLimiting;

namespace PoMiniGames.AI;

/// <summary>
/// The one account-wide ceiling on how many model calls may be in flight at once, shared by every
/// resilience pipeline in <see cref="AzureOpenAIResilience"/>.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why this exists.</b> <see cref="AzureOpenAIResilience.MaxConcurrentCalls"/> documents a
/// measured account ceiling — "two concurrent return in 3.6 s and 9.0 s; three concurrent complete
/// <em>one</em> and drop the other two" — and the pipeline enforced it with
/// <c>AddConcurrencyLimiter</c>. That call builds a limiter <b>per pipeline</b>, and the partitioned
/// registration then built five of them (the shared fallback plus one per game in
/// <see cref="AzureOpenAIResilience.PartitionedGames"/>). The host therefore permitted ten
/// concurrent calls against an account that serves one or two, which is the stampede the limit was
/// written to prevent: partitioning bought per-game isolation and silently discarded the global
/// ceiling it was isolating.
/// </para>
/// <para>
/// <b>Two levels, not one.</b> Collapsing back to a single shared limiter would restore the
/// ceiling and reintroduce the starvation bug the partitions fixed — one game's loop holding
/// both permits continuously while another queues behind it forever. So the pipeline
/// now stacks them: a per-game limiter for fairness (a game may not have more than
/// <see cref="AzureOpenAIResilience.PerGameConcurrency"/> calls contending at once), and this
/// single global limiter inside it for the real account ceiling.
/// </para>
/// <para>
/// <b>Queue sizing is a correctness property.</b> The global queue must be able to hold every
/// caller the per-game limiters can admit simultaneously — otherwise a game that legitimately won
/// its own permit is rejected here, which reads as a provider failure and trips its circuit
/// breaker. <see cref="AzureOpenAIResilience.GlobalQueueLimit"/> is therefore computed from the
/// partition count rather than picked.
/// </para>
/// <para>
/// Registered as a singleton so the container owns its lifetime; the limiter is disposed with the
/// host. One instance per container (not a process-wide static) so a test host that builds several
/// containers does not have them contend over one gate.
/// </para>
/// </remarks>
public sealed class AiConcurrencyGate : IDisposable
{
    private readonly ConcurrencyLimiter _limiter;

    public AiConcurrencyGate()
        : this(AzureOpenAIResilience.MaxConcurrentCalls, AzureOpenAIResilience.GlobalQueueLimit)
    {
    }

    /// <summary>Test constructor — lets a test squeeze the gate without touching the constants.</summary>
    public AiConcurrencyGate(int permitLimit, int queueLimit)
    {
        PermitLimit = permitLimit;
        QueueLimit = queueLimit;
        _limiter = new ConcurrencyLimiter(new ConcurrencyLimiterOptions
        {
            PermitLimit = permitLimit,
            QueueLimit = queueLimit,
            // Oldest-first: a call that has already waited is the one that should go next.
            // Newest-first would let a busy game's fresh calls jump a starving game's old one,
            // which is the fairness property the per-game limiters exist to provide.
            QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
        });
    }

    /// <summary>Calls allowed in flight at once across the whole host.</summary>
    public int PermitLimit { get; }

    /// <summary>Calls allowed to wait for a permit before the gate rejects outright.</summary>
    public int QueueLimit { get; }

    /// <summary>
    /// Acquires one permit, waiting in the queue when the gate is full. The returned lease is
    /// released when Polly disposes it at the end of the pipeline step.
    /// </summary>
    public ValueTask<RateLimitLease> AcquireAsync(CancellationToken cancellationToken)
        => _limiter.AcquireAsync(permitCount: 1, cancellationToken);

    /// <summary>
    /// Permits not currently held, for the diagnostics surface. Zero means every in-flight slot is
    /// taken and further calls are queueing — the signal that the account, not the app, is the
    /// bottleneck.
    /// </summary>
    public int AvailablePermits => (int)(_limiter.GetStatistics()?.CurrentAvailablePermits ?? 0);

    /// <summary>Calls that have been rejected by this gate since startup.</summary>
    public long TotalRejected => _limiter.GetStatistics()?.TotalFailedLeases ?? 0;

    /// <summary>Calls that have been admitted by this gate since startup.</summary>
    public long TotalAdmitted => _limiter.GetStatistics()?.TotalSuccessfulLeases ?? 0;

    public void Dispose() => _limiter.Dispose();
}
