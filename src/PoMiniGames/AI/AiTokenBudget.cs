using System.Collections.Concurrent;

namespace PoMiniGames.AI;

/// <summary>
/// Bound on how many model tokens one caller may spend per UTC day, across the whole AI surface.
/// </summary>
/// <remarks>
/// The only thing in front of the metered relay was a rate limit — 10 requests/second per
/// IP+identity partition, with no token accounting whatsoever. One browser tab left open could
/// therefore issue on the order of 36 000 calls an hour against a paid deployment and nothing in
/// the app would notice, let alone refuse. Rate limiting shapes burst; it does not bound spend.
/// </remarks>
public sealed class AiTokenBudgetOptions
{
    public const string SectionName = "PoMiniGames:AI:TokenBudget";

    /// <summary>
    /// Tokens one identity may spend per UTC day. 0 or negative disables the ceiling — which is
    /// a deliberate opt-out, not the default.
    /// </summary>
    public long DailyTokensPerIdentity { get; set; } = 250_000;
}

/// <summary>
/// Tracks per-identity token spend for the current UTC day and refuses callers who have used
/// their allowance. Singleton, process-local — same shape as the host's other in-memory registries.
/// </summary>
public sealed class AiTokenBudget
{
    private readonly ConcurrentDictionary<string, Ledger> _ledgers = new(StringComparer.Ordinal);
    private readonly Func<DateTimeOffset> _clock;
    private readonly long _dailyLimit;

    public AiTokenBudget(Microsoft.Extensions.Options.IOptions<AiTokenBudgetOptions> options)
        : this(options.Value.DailyTokensPerIdentity, () => DateTimeOffset.UtcNow)
    {
    }

    /// <summary>Test/diagnostics constructor with an injectable clock.</summary>
    public AiTokenBudget(long dailyTokensPerIdentity, Func<DateTimeOffset> clock)
    {
        _dailyLimit = dailyTokensPerIdentity;
        _clock = clock;
    }

    private sealed class Ledger
    {
        public DateOnly Day;
        public long Spent;
    }

    /// <summary>True when the ceiling is switched off entirely.</summary>
    public bool IsUnlimited => _dailyLimit <= 0;

    /// <param name="Allowed">False when this identity has already spent its daily allowance.</param>
    /// <param name="Spent">Tokens spent so far today.</param>
    /// <param name="Limit">The daily ceiling in force.</param>
    /// <param name="ResetUtc">Start of the next UTC day, when the allowance returns.</param>
    public readonly record struct Verdict(bool Allowed, long Spent, long Limit, DateTimeOffset ResetUtc);

    /// <summary>
    /// Asks whether <paramref name="identity"/> may make another call. Checked <em>before</em> the
    /// call rather than reserving an estimate: a decision call's true cost is only known from the
    /// reply, and refusing on a guess would either over- or under-charge every caller.
    /// </summary>
    public Verdict Check(string identity)
    {
        var now = _clock();
        var reset = new DateTimeOffset(now.UtcDateTime.Date.AddDays(1), TimeSpan.Zero);

        if (IsUnlimited)
            return new Verdict(true, 0, 0, reset);

        var spent = SpentToday(identity, now);
        return new Verdict(spent < _dailyLimit, spent, _dailyLimit, reset);
    }

    /// <summary>Adds the actual token cost of a completed call.</summary>
    public void Record(string identity, long tokens)
    {
        if (IsUnlimited || tokens <= 0) return;

        var today = DateOnly.FromDateTime(_clock().UtcDateTime);
        var ledger = _ledgers.GetOrAdd(identity, _ => new Ledger { Day = today });
        lock (ledger)
        {
            if (ledger.Day != today)
            {
                ledger.Day = today;
                ledger.Spent = 0;
            }
            ledger.Spent += tokens;
        }
    }

    /// <summary>Tokens spent by this identity so far today.</summary>
    public long SpentToday(string identity) => SpentToday(identity, _clock());

    private long SpentToday(string identity, DateTimeOffset now)
    {
        if (!_ledgers.TryGetValue(identity, out var ledger)) return 0;
        var today = DateOnly.FromDateTime(now.UtcDateTime);
        lock (ledger)
        {
            return ledger.Day == today ? ledger.Spent : 0;
        }
    }
}
