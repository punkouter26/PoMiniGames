using System.Collections.Concurrent;
using System.Security.Cryptography;
using PoMiniGames.Shared.Games.PoJevArena;

namespace PoMiniGames.Features.PoJevArena;

public enum ArenaResultGate
{
    Accepted,
    AlreadyReported,
    TooFewDecisions,
}

/// <summary>
/// One registered match: the frozen rosters (so a mid-match library edit changes nothing and Jev's
/// prompt names come from here, not the client), the owner, and what it has spent.
/// </summary>
public sealed class ArenaMatch(string matchId, string ownerId, ArenaRoster roster, ArenaMode mode, int seed, DateTimeOffset now)
{
    private int _decisions;
    private long _costMicroUsd;
    private int _reported;
    private long _lastTouchedTicks = now.UtcTicks;

    public string MatchId { get; } = matchId;
    public string OwnerId { get; } = ownerId;
    public ArenaRoster Roster { get; } = roster;
    public ArenaMode Mode { get; } = mode;
    public int Seed { get; } = seed;

    public int Decisions => Volatile.Read(ref _decisions);
    public double CostUsd => Interlocked.Read(ref _costMicroUsd) / 1_000_000.0;

    internal DateTimeOffset LastTouched => new(Interlocked.Read(ref _lastTouchedTicks), TimeSpan.Zero);

    internal void Touch(DateTimeOffset now) => Interlocked.Exchange(ref _lastTouchedTicks, now.UtcTicks);

    /// <summary>Counts answered decisions only — the paid work the result gate requires.</summary>
    public void RecordDecisions(int count, double costUsd)
    {
        Interlocked.Add(ref _decisions, count);
        Interlocked.Add(ref _costMicroUsd, (long)Math.Round(costUsd * 1_000_000));
    }

    /// <summary>
    /// One result per match, and only after at least <see cref="ArenaMatchRegistry.MinDecisionsForResult"/>
    /// answered decisions (about two seconds of a full 10v10), so library win rates cannot be
    /// farmed by reporting matches that never really ran.
    /// </summary>
    public ArenaResultGate TryClaimResult()
    {
        if (Decisions < ArenaMatchRegistry.MinDecisionsForResult) return ArenaResultGate.TooFewDecisions;
        return Interlocked.Exchange(ref _reported, 1) == 0 ? ArenaResultGate.Accepted : ArenaResultGate.AlreadyReported;
    }
}

/// <summary>
/// Process-local registry of live matches with a sliding idle expiry. Process-local on purpose,
/// like every other lobby in the host: an F1 recycle forgets live matches, and the client then
/// sees 404 ("match expired — redeploy") rather than anything worse.
/// </summary>
public sealed class ArenaMatchRegistry(TimeProvider clock)
{
    public const int MinDecisionsForResult = 40;
    public static readonly TimeSpan IdleExpiry = TimeSpan.FromMinutes(15);

    /// <summary>Upper bound on live matches; the oldest idle ones are swept first.</summary>
    private const int MaxLiveMatches = 2_000;

    private readonly ConcurrentDictionary<string, ArenaMatch> _matches = new(StringComparer.Ordinal);

    public ArenaMatch Register(string ownerId, ArenaRoster roster, ArenaMode mode)
    {
        var now = clock.GetUtcNow();
        Sweep(now);

        var id = Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant();
        var match = new ArenaMatch(id, ownerId, roster, mode, RandomNumberGenerator.GetInt32(1, int.MaxValue), now);
        _matches[id] = match;
        return match;
    }

    /// <summary>
    /// The caller's live match, or null — for an unknown id, an expired one, and someone else's
    /// alike, so a match id reveals nothing to a caller who does not own it.
    /// </summary>
    public ArenaMatch? Find(string matchId, string ownerId)
    {
        if (!_matches.TryGetValue(matchId, out var match)) return null;

        var now = clock.GetUtcNow();
        if (now - match.LastTouched > IdleExpiry)
        {
            _matches.TryRemove(matchId, out _);
            return null;
        }

        if (!string.Equals(match.OwnerId, ownerId, StringComparison.Ordinal)) return null;

        match.Touch(now);
        return match;
    }

    private void Sweep(DateTimeOffset now)
    {
        foreach (var (id, match) in _matches)
        {
            if (now - match.LastTouched > IdleExpiry) _matches.TryRemove(id, out _);
        }

        if (_matches.Count < MaxLiveMatches) return;
        foreach (var stale in _matches.Values.OrderBy(m => m.LastTouched).Take(_matches.Count - MaxLiveMatches + 1))
        {
            _matches.TryRemove(stale.MatchId, out _);
        }
    }
}
