using System.Collections.Concurrent;
using PoMiniGames.Application.Services;
using PoMiniGames.Domain.Models;
using PoShared.Games;

namespace PoMiniGames.Features.PoSports;

/// <summary>
/// Server-authoritative PoSports meet. Wraps a <see cref="PoSportsSim"/> with a 60 Hz
/// tick timer and a 15 Hz snapshot broadcast, routes each connection's keys to its
/// lane, and persists every human lane's result when the meet reaches the podium.
/// Construct with <paramref name="startTimers"/>=false in tests and drive
/// <see cref="Advance"/> manually — the sim itself stays deterministic.
/// </summary>
public sealed class PoSportsRaceService : IAsyncDisposable
{
    private const int TickHz = 60;
    private const int SnapshotHz = 15;

    private sealed record LaneOwner(string ConnectionId, string UserId, bool IsGuest);

    private readonly ILogger<PoSportsRaceService> _log;
    private readonly IStorageService _storage;
    private readonly PoSportsLobbyService _lobby;
    private readonly Timer? _tick;
    private readonly Timer? _snap;
    private readonly object _stateLock = new();
    private readonly PoSportsSim _sim;
    /// <summary>lane index → owning connection. Only human lanes appear here.</summary>
    private readonly ConcurrentDictionary<int, LaneOwner> _owners = new();
    /// <summary>lane index → the seat that lane was seeded from (human lanes only).</summary>
    private readonly Dictionary<int, PoSportsRaceSeat> _seats = [];
    private bool _finishedHandled;
    private bool _disposed;

    public string GameCode { get; }

    /// <summary>
    /// True once the meet reached the podium. The registry must never hand a finished
    /// race to a rematch — the sim's podium phase is terminal, so joiners would be
    /// pinned to the previous meet's results.
    /// </summary>
    public bool IsFinished
    {
        get { lock (_stateLock) return _finishedHandled; }
    }
    public event Action<PoSportsSnapshot>? SnapshotReady;
    public event Action<PoSportsSnapshot>? Finished;

    public PoSportsRaceService(
        string gameCode,
        IReadOnlyList<PoSportsRaceSeat> seats,
        PoSportsLobbyService lobby,
        IStorageService storage,
        ILogger<PoSportsRaceService> log,
        bool startTimers = true,
        int? seed = null)
    {
        GameCode = gameCode;
        _lobby = lobby;
        _storage = storage;
        _log = log;

        // Humans take the first lanes in join order; AI family members fill the rest
        // of the 4-lane track with characters nobody picked.
        var setups = new List<PoSportsSim.LaneSetup>();
        foreach (var seat in seats.Take(PoSportsLobbyService.MaxPlayers))
        {
            _seats[setups.Count] = seat;
            setups.Add(new PoSportsSim.LaneSetup(seat.DisplayName, seat.Character, IsAi: false));
        }
        var free = PoSportsConstants.Characters.Except(seats.Select(s => s.Character)).ToList();
        for (var i = 0; setups.Count < PoSportsLobbyService.MaxPlayers && i < free.Count; i++)
        {
            setups.Add(new PoSportsSim.LaneSetup($"CPU {free[i]}", free[i], IsAi: true));
        }
        _sim = new PoSportsSim(setups, seed);

        if (startTimers)
        {
            _tick = new Timer(_ => TickSafe(), null,
                TimeSpan.FromMilliseconds(1000.0 / TickHz), TimeSpan.FromMilliseconds(1000.0 / TickHz));
            _snap = new Timer(_ => SnapshotSafe(), null,
                TimeSpan.FromMilliseconds(1000.0 / SnapshotHz), TimeSpan.FromMilliseconds(1000.0 / SnapshotHz));
        }
    }

    // ── Connections ───────────────────────────────────────────────────────

    /// <summary>
    /// Bind a connection to its lane and return the lane index, or null when the caller
    /// owns no lane (a spectator). A rejoin resets the lane's sequence progress — the
    /// player's rhythm, not their speed, restarts.
    /// </summary>
    /// <remarks>
    /// Lanes are matched on the claim-derived <paramref name="userId"/> from the lobby
    /// seat, NOT on <paramref name="displayName"/>: the lobby stores names through
    /// <see cref="PoSportsLobbyService.SanitizeName"/>, so a &gt;24-char or padded name
    /// never equals its own lane, and a page refresh sends a default name — both silently
    /// demoted the player to a spectator whose keys were dropped. The name path survives
    /// only as a fallback for callers with no stable id, and sanitizes before comparing.
    /// </remarks>
    public int? RegisterOwner(string connectionId, string displayName, string userId, bool isGuest)
    {
        lock (_stateLock)
        {
            var existing = _owners.FirstOrDefault(kv => kv.Value.ConnectionId == connectionId);
            if (existing.Value is not null)
            {
                return existing.Key; // same connection re-joining its own lane — no reset
            }
            // A new connection binding this player's lane: an unclaimed lane first
            // (initial join / rejoin after disconnect), else steal the stale bind
            // (reconnect where the old connection never formally disconnected).
            var lane = MatchLane(displayName, userId, requireUnclaimed: true)
                       ?? MatchLane(displayName, userId, requireUnclaimed: false)
                       ?? -1;
            if (lane < 0) return null;
            // Any new connection restarts the player's typing rhythm — banked speed
            // survives, sequence progress does not.
            _sim.Lane(lane).SeqProgress = 0;
            _owners[lane] = new LaneOwner(connectionId, userId, isGuest);
            return lane;
        }
    }

    /// <summary>
    /// Find this player's human lane: by seat identity when the caller has a stable id,
    /// else by sanitized name. Callers hold <see cref="_stateLock"/>.
    /// </summary>
    private int? MatchLane(string displayName, string userId, bool requireUnclaimed)
    {
        var name = PoSportsLobbyService.SanitizeName(displayName);
        foreach (var l in _sim.Lanes)
        {
            if (l.IsAi) continue;
            if (requireUnclaimed && _owners.ContainsKey(l.Index)) continue;
            var seat = _seats.TryGetValue(l.Index, out var s) ? s : null;
            var matched = !string.IsNullOrEmpty(userId) && seat is not null && !string.IsNullOrEmpty(seat.UserId)
                ? string.Equals(seat.UserId, userId, StringComparison.Ordinal)
                : string.Equals(l.Name, name, StringComparison.Ordinal);
            if (matched) return l.Index;
        }
        return null;
    }

    public void RemoveConnection(string connectionId)
    {
        foreach (var kv in _owners.Where(kv => kv.Value.ConnectionId == connectionId).ToList())
        {
            _owners.TryRemove(kv.Key, out _);
        }
        // The lane itself keeps running and simply decays — a reconnect rebinds it.
    }

    // ── Input ─────────────────────────────────────────────────────────────

    public void SendSequenceKey(string connectionId, int step)
    {
        if (LaneFor(connectionId) is { } lane)
        {
            lock (_stateLock) _sim.HandleSequenceKey(lane, step);
        }
    }

    public void SendJump(string connectionId)
    {
        if (LaneFor(connectionId) is { } lane)
        {
            lock (_stateLock) _sim.HandleJump(lane);
        }
    }

    private int? LaneFor(string connectionId)
    {
        foreach (var kv in _owners)
        {
            if (kv.Value.ConnectionId == connectionId) return kv.Key;
        }
        return null;
    }

    // ── Simulation ────────────────────────────────────────────────────────

    /// <summary>Advance the meet by dt seconds (test entry point; timers call this too).</summary>
    public void Advance(double dt)
    {
        PoSportsSnapshot? final = null;
        lock (_stateLock)
        {
            _sim.Tick(dt);
            if (_sim.Phase == "podium" && !_finishedHandled)
            {
                _finishedHandled = true;
                final = _sim.Snapshot();
            }
        }
        if (final is not null) HandleFinished(final);
    }

    public PoSportsSnapshot Snapshot()
    {
        lock (_stateLock) return _sim.Snapshot();
    }

    private void TickSafe()
    {
        try { Advance(1.0 / TickHz); }
        catch (Exception ex) { _log.LogError(ex, "PoSports race tick failed"); }
    }

    private void SnapshotSafe()
    {
        try { SnapshotReady?.Invoke(Snapshot()); }
        catch (Exception ex) { _log.LogError(ex, "PoSports race snapshot failed"); }
    }

    private void HandleFinished(PoSportsSnapshot final)
    {
        // The podium is terminal: further ticks are no-ops and every snapshot from here
        // is byte-identical, so stop both timers instead of broadcasting the same podium
        // ~450 more times across the registry's 30 s grace window. Clients already got
        // the final state on "raceFinished".
        _tick?.Change(Timeout.Infinite, Timeout.Infinite);
        _snap?.Change(Timeout.Infinite, Timeout.Infinite);

        // Persist every human lane's meet — guests included (IsGuest rows rank too).
        foreach (var lane in final.Lanes.Where(l => !l.IsAi))
        {
            // Prefer the live connection's identity, but fall back to the lobby seat so a
            // player who dropped before the podium still gets their run attributed.
            var owner = _owners.TryGetValue(lane.Lane, out var o) ? o : null;
            var seat = _seats.TryGetValue(lane.Lane, out var s) ? s : null;
            var entry = new PoSportsHighScore
            {
                PlayerName = lane.Name,
                UserId = owner?.UserId ?? seat?.UserId ?? "",
                IsGuest = owner?.IsGuest ?? seat?.IsGuest ?? true,
                SprintSeconds = lane.SprintSeconds,
                HurdlesSeconds = lane.HurdlesSeconds,
                TotalTimeSeconds = lane.SprintSeconds + lane.HurdlesSeconds,
                Character = lane.Character,
                Date = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                GameCode = GameCode,
            };
            // Fire-and-forget with logging: a storage hiccup must not kill the podium.
            _ = PersistAsync(entry);
        }
        _lobby.EndRace();
        Finished?.Invoke(final);
    }

    private async Task PersistAsync(PoSportsHighScore entry)
    {
        try
        {
            await _storage.SavePoSportsHighScoreAsync(entry);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "PoSports score persist failed for {Player}", entry.PlayerName);
        }
    }

    /// <summary>Idempotent: a displaced race is disposed at once and again by the delayed sweep.</summary>
    public async ValueTask DisposeAsync()
    {
        lock (_stateLock)
        {
            if (_disposed) return;
            _disposed = true;
        }
        if (_tick is not null) await _tick.DisposeAsync();
        if (_snap is not null) await _snap.DisposeAsync();
    }
}
