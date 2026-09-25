using PoMiniGames.AI;

namespace PoMiniGames.Features.PoJevArena;

/// <summary>
/// The per-identity daily Jev call cap. It is an <see cref="AiTokenBudget"/> counting calls instead
/// of tokens — same durable write-behind ledger, same UTC-day reset, same increment-under-ETag
/// storage (table <see cref="TableName"/>) — so this type only adds batch semantics: a decision
/// batch is admitted whole or refused whole, never trimmed to whoever fits.
/// </summary>
public sealed class JevCallAllowance(AiTokenBudget budget)
{
    /// <summary>Ensured at startup by <c>StorageInitializer</c>.</summary>
    public const string TableName = "PoJevArenaCallLedger";

    /// <param name="Allowed">True when <c>Used + calls</c> fits under the limit.</param>
    public readonly record struct Verdict(bool Allowed, long Used, long Limit, long Remaining, DateTimeOffset ResetUtc);

    /// <summary>Exposed for the write-behind flusher, which is the stock <see cref="AiTokenBudgetFlushService"/>.</summary>
    public AiTokenBudget Budget => budget;

    /// <summary>Hydrates this identity's durable total, then asks whether <paramref name="calls"/> more fit.</summary>
    public async Task<Verdict> CheckAsync(string identity, int calls, CancellationToken ct = default)
    {
        var v = await budget.CheckAsync(identity, ct);
        if (budget.IsUnlimited) return new Verdict(true, 0, 0, long.MaxValue, v.ResetUtc);

        var remaining = Math.Max(0, v.Limit - v.Spent);
        return new Verdict(calls <= remaining, v.Spent, v.Limit, remaining, v.ResetUtc);
    }

    /// <summary>Charges the calls actually sent upstream (failed calls still cost a request).</summary>
    public void Record(string identity, int calls) => budget.Record(identity, calls);
}
