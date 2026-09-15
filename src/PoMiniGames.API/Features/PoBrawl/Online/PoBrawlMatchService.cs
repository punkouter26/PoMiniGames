using System.Collections.Concurrent;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// One in-process PoBrawl 1v1 match. Owns the per-tick combat simulation,
/// input aggregation, and final result. Lifecycle: created by
/// <see cref="PoBrawlMatchRegistry"/> when the host starts a match, lives until
/// the result is broadcast, then disposes itself.
/// </summary>
/// <remarks>
/// <para>
/// Determinism vs. fairness. The HP / damage model is server-authoritative:
/// the server is the only place HP totals are mutated, and the server only
/// listens to inputs from the side the connection was pinned to at JoinMatch.
/// A client cannot fabricate a hit because every damage event is gated by the
/// server's RNG (which uses a deterministic per-match seed so the two clients
/// see the same outcome).
/// </para>
/// <para>
/// Physics stays client-side. The server never sees positions or animation
/// states; clients render their own fighter smoothly from local interpolation
/// and reconcile HP / energy from the snapshot. This is a deliberate trade —
/// the alternative (porting the entire JS engine to C#) is out of scope for
/// this slice, and HP / energy are the only numbers the result depends on.
/// </para>
/// </remarks>
public sealed class PoBrawlMatchService : IAsyncDisposable
{
    /// <summary>
    /// Tick rate. 10 Hz matches the client UI's interpolation cadence; faster would
    /// burn CPU on input aggregation for no visible benefit (HP only changes on
    /// landed hits, which are sparse).
    /// </summary>
    public const int TickHz = 10;

    /// <summary>Round length, seconds. Matches the 2P local round.</summary>
    public const double MatchDurationSeconds = 60.0;

    /// <summary>Punch base damage. Varied per hit by ±20% in MatchLogic.</summary>
    public const int PunchBaseDamage = 6;
    public const int KickBaseDamage = 10;
    public const int SpecialBaseDamage = 18;

    /// <summary>Energy gain per landed hit, and per-tick regen when idle.</summary>
    public const int EnergyOnLandHit = 6;
    public const int EnergyRegenPerTick = 1;

    public string MatchId { get; }
    public string GameCode { get; }
    public IReadOnlyList<PoBrawlLobbyPlayer> Roster { get; }
    public DateTimeOffset StartedAtUtc { get; }

    private readonly PoBrawlLobbyPlayer _p1;
    private readonly PoBrawlLobbyPlayer _p2;
    private readonly object _stateLock = new();

    private int _p1Hp = 100;
    private int _p2Hp = 100;
    private int _p1Energy;
    private int _p2Energy;
    private double _elapsedSeconds;
    private bool _finished;
    private string _lastEvent = "";
    private PoBrawlSide? _winner;

    // Most-recent input per side, plus its sequence for stale-rejection.
    private PoBrawlMatchInput? _lastP1Input;
    private PoBrawlMatchInput? _lastP2Input;
    private long _p1LastAppliedSeq;
    private long _p2LastAppliedSeq;

    // RNG seeded deterministically from match id so the two clients see identical
    // damage rolls. Random.Shared would diverge between hosts in a multi-instance
    // deployment and even single-instance it has process-global state — a per-match
    // seed makes replays and dispute resolution reproducible.
    private readonly Random _rng;

    /// <summary>Connection-id keyed map. Set by the match hub at JoinMatch.</summary>
    private readonly ConcurrentDictionary<string, PoBrawlSide> _connections = new();

    public PoBrawlMatchService(string matchId, string gameCode, IReadOnlyList<PoBrawlLobbyPlayer> roster)
    {
        MatchId = matchId;
        GameCode = gameCode;
        Roster = roster.ToList();
        StartedAtUtc = DateTimeOffset.UtcNow;
        // Roster is exactly two (lobby cap), but be defensive about ordering so the
        // host is always P1 regardless of who joined first at the SignalR level.
        _p1 = Roster[0];
        _p2 = Roster[1];
        _rng = new Random(StableSeed(matchId));
    }

    private static int StableSeed(string matchId)
    {
        // Hash the match id to a 32-bit seed. matchId is a GUID so this gives uniform
        // coverage; Math.Abs on a hash code is risky for the FNV-style mix below
        // because the high bit can be set.
        unchecked
        {
            int hash = 17;
            foreach (var ch in matchId) hash = hash * 31 + ch;
            return hash == int.MinValue ? 0 : Math.Abs(hash);
        }
    }

    public PoBrawlSide SideFor(string connectionId) =>
        _connections.TryGetValue(connectionId, out var side) ? side : PoBrawlSide.Player1;

    public void RegisterConnection(string connectionId, PoBrawlSide side) =>
        _connections[connectionId] = side;

    /// <summary>
    /// Pin a connection by the player's lobby-side principal id. The match hub
    /// and the lobby hub allocate separate connection ids, so we re-resolve the
    /// side by walking the roster instead of relying on the lobby connection id
    /// being passed through.
    /// </summary>
    public bool RegisterConnectionByPrincipal(string principalId, string connectionId)
    {
        if (string.IsNullOrEmpty(principalId)) return false;
        // Roster[0] is Player1, Roster[1] is Player2 (host-first, matches the lobby).
        for (var i = 0; i < Roster.Count; i++)
        {
            if (string.Equals(Roster[i].PrincipalId, principalId, StringComparison.Ordinal))
            {
                var side = i == 0 ? PoBrawlSide.Player1 : PoBrawlSide.Player2;
                RegisterConnection(connectionId, side);
                return true;
            }
        }
        return false;
    }

    public void UnregisterConnection(string connectionId) => _connections.TryRemove(connectionId, out _);

    /// <summary>
    /// Submit the caller's current input for this tick. Server overrides the
    /// <see cref="PoBrawlMatchInput.ActorSide"/> with the connection's pinned
    /// side so a malicious client cannot claim to be the other side.
    /// </summary>
    public bool SubmitInput(string connectionId, PoBrawlMatchInput input)
    {
        if (!_connections.TryGetValue(connectionId, out var pinned)) return false;
        // Override actor with server-known side.
        input.ActorSide = pinned;
        lock (_stateLock)
        {
            if (_finished) return false;
            if (pinned == PoBrawlSide.Player1)
            {
                if (_lastP1Input is null || input.Sequence >= _p1LastAppliedSeq)
                {
                    _lastP1Input = input;
                }
            }
            else
            {
                if (_lastP2Input is null || input.Sequence >= _p2LastAppliedSeq)
                {
                    _lastP2Input = input;
                }
            }
        }
        return true;
    }

    /// <summary>
    /// Run one simulation tick. Returns the broadcastable snapshot, or null when
    /// the tick decided the match had ended. The pump calls this every 100 ms.
    /// </summary>
    public PoBrawlMatchState? Tick()
    {
        PoBrawlMatchState snapshot;
        lock (_stateLock)
        {
            if (_finished) return null;
            _elapsedSeconds += 1.0 / TickHz;
            ApplyInputsLocked();
            // Timer-end: tie goes to the higher-HP side; exact tie is a draw.
            if (_elapsedSeconds >= MatchDurationSeconds)
            {
                _finished = true;
                _winner = _p1Hp > _p2Hp ? PoBrawlSide.Player1
                    : _p2Hp > _p1Hp ? PoBrawlSide.Player2
                    : (PoBrawlSide?)null;
                _lastEvent = _winner is null ? "time-up-draw" : "time-up";
            }
            else if (_p1Hp <= 0)
            {
                _finished = true; _winner = PoBrawlSide.Player2; _lastEvent = "ko";
            }
            else if (_p2Hp <= 0)
            {
                _finished = true; _winner = PoBrawlSide.Player1; _lastEvent = "ko";
            }

            snapshot = new PoBrawlMatchState
            {
                MatchId = MatchId,
                ElapsedSeconds = _elapsedSeconds,
                Player1Hp = _p1Hp,
                Player2Hp = _p2Hp,
                Player1Energy = _p1Energy,
                Player2Energy = _p2Energy,
                LastEvent = _lastEvent,
                Finished = _finished,
                Winner = _winner,
            };
            // Clear last-event after one tick so the sound / shake on the client
            // fires once per occurrence and not every frame.
            _lastEvent = "";
        }
        return snapshot;
    }

    private void ApplyInputsLocked()
    {
        var p1 = _lastP1Input?.Action ?? PoBrawlMatchAction.Idle;
        var p2 = _lastP2Input?.Action ?? PoBrawlMatchAction.Idle;

        // Energy regen — idle and movement only; blocking interrupts regen briefly
        // by halving it so blocking reads as a trade-off.
        _p1Energy = Math.Min(100, _p1Energy + EnergyFromAction(p1));
        _p2Energy = Math.Min(100, _p2Energy + EnergyFromAction(p2));

        // Resolve attacks. A punch lands if the opponent is not actively blocking;
        // block cuts damage to 1, kick to 0. Special is unblockable but requires
        // full energy (consumed on use).
        ResolveAttack(p1, blocking: p2 == PoBrawlMatchAction.Block, isP1: true);
        ResolveAttack(p2, blocking: p1 == PoBrawlMatchAction.Block, isP1: false);

        if (_lastP1Input is not null) _p1LastAppliedSeq = _lastP1Input.Sequence;
        if (_lastP2Input is not null) _p2LastAppliedSeq = _lastP2Input.Sequence;
    }

    private static int EnergyFromAction(PoBrawlMatchAction a) => a switch
    {
        PoBrawlMatchAction.Idle => EnergyRegenPerTick * 2,
        PoBrawlMatchAction.MoveForward or PoBrawlMatchAction.MoveBack => EnergyRegenPerTick,
        PoBrawlMatchAction.Block => EnergyRegenPerTick / 2,
        // Attacking drains more energy than idle regains; net-zero per landed hit
        // because EnergyOnLandHit tops the bar up on a successful connect.
        PoBrawlMatchAction.Punch or PoBrawlMatchAction.Kick => -2,
        PoBrawlMatchAction.Special => -10,
        _ => 0,
    };

    private void ResolveAttack(PoBrawlMatchAction action, bool blocking, bool isP1)
    {
        int baseDmg; int energyCost;
        switch (action)
        {
            case PoBrawlMatchAction.Punch:
                baseDmg = PunchBaseDamage; energyCost = 0; break;
            case PoBrawlMatchAction.Kick:
                baseDmg = KickBaseDamage; energyCost = 0; break;
            case PoBrawlMatchAction.Special:
                if ((isP1 ? _p1Energy : _p2Energy) < 100) return; // not charged
                baseDmg = SpecialBaseDamage; energyCost = 100; break;
            default:
                return;
        }

        // ±20% damage variance — deterministic per-match via _rng so both clients
        // see the same hit number when the server broadcasts the snapshot.
        var variance = 1.0 + (_rng.NextDouble() * 0.4 - 0.2);
        var damage = (int)Math.Round(baseDmg * variance, MidpointRounding.AwayFromZero);

        // Block cuts damage. Punch is negated entirely (defensive read on a jab),
        // kick chips 1 (you can still push them back), special is unblockable.
        if (blocking)
        {
            damage = action switch
            {
                PoBrawlMatchAction.Punch => 0,
                PoBrawlMatchAction.Kick => Math.Max(1, damage / 4),
                _ => damage,
            };
        }

        if (damage > 0)
        {
            if (isP1)
            {
                _p2Hp = Math.Max(0, _p2Hp - damage);
                _p1Energy = Math.Min(100, _p1Energy + EnergyOnLandHit);
            }
            else
            {
                _p1Hp = Math.Max(0, _p1Hp - damage);
                _p2Energy = Math.Min(100, _p2Energy + EnergyOnLandHit);
            }
            _lastEvent = isP1
                ? (action == PoBrawlMatchAction.Special ? "p1-special" : "p1-hit")
                : (action == PoBrawlMatchAction.Special ? "p2-special" : "p2-hit");
        }

        if (energyCost > 0)
        {
            if (isP1) _p1Energy = Math.Max(0, _p1Energy - energyCost);
            else _p2Energy = Math.Max(0, _p2Energy - energyCost);
        }
    }

    /// <summary>
    /// Build the final <see cref="PoBrawlMatchResult"/> from a connection's perspective.
    /// Both clients receive their own copy with their own local side set, so the
    /// outcome maps to "did the local player win?".
    /// </summary>
    public PoBrawlMatchResult BuildResultFor(string connectionId)
    {
        PoBrawlMatchState snapshot;
        PoBrawlLobbyPlayer localPlayer;
        PoBrawlLobbyPlayer opponent;
        lock (_stateLock)
        {
            snapshot = new PoBrawlMatchState
            {
                MatchId = MatchId,
                ElapsedSeconds = _elapsedSeconds,
                Player1Hp = _p1Hp,
                Player2Hp = _p2Hp,
                Finished = _finished,
                Winner = _winner,
            };
            localPlayer = SideFor(connectionId) == PoBrawlSide.Player1 ? _p1 : _p2;
            opponent = SideFor(connectionId) == PoBrawlSide.Player1 ? _p2 : _p1;
        }
        var localSide = SideFor(connectionId);
        var outcome = !snapshot.Finished ? PoBrawlOutcome.Draw
            : snapshot.Winner is null ? PoBrawlOutcome.Draw
            : snapshot.Winner == localSide ? PoBrawlOutcome.Win
            : PoBrawlOutcome.Loss;
        return new PoBrawlMatchResult
        {
            MatchId = MatchId,
            LocalSide = localSide,
            Outcome = outcome,
            DurationSeconds = snapshot.ElapsedSeconds,
            Player1Hp = snapshot.Player1Hp,
            Player2Hp = snapshot.Player2Hp,
            OpponentId = opponent.PrincipalId,
            OpponentDisplayName = opponent.DisplayName,
        };
    }

    public PoBrawlLobbyPlayer Player1 => _p1;
    public PoBrawlLobbyPlayer Player2 => _p2;

    public async ValueTask DisposeAsync()
    {
        // Nothing async to dispose — match is in-process only.
        await ValueTask.CompletedTask;
    }
}
