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
    private bool _finishedHandled;

    public string GameCode { get; }
    public event Action<PoSportsSnapshot>? SnapshotReady;
    public event Action<PoSportsSnapshot>? Finished;

    public PoSportsRaceService(
        string gameCode,
        IReadOnlyList<PoSportsLobbyMember> members,
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
        foreach (var m in members.Take(PoSportsLobbyService.MaxPlayers))
        {
            setups.Add(new PoSportsSim.LaneSetup(m.DisplayName, m.Character, IsAi: false));
        }
        var free = PoSportsConstants.Characters.Except(members.Select(m => m.Character)).ToList();
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
    /// Bind a connection to its lane (matched by lobby display name at first join,
    /// or rebind by connection on rejoin). A rejoin resets the lane's sequence
    /// progress — the player's rhythm, not their speed, restarts.
    /// </summary>
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
            var lane = _sim.Lanes.FirstOrDefault(l => !l.IsAi && l.Name == displayName
                                                      && !_owners.ContainsKey(l.Index))?.Index
                       ?? _sim.Lanes.FirstOrDefault(l => !l.IsAi && l.Name == displayName)?.Index
                       ?? -1;
            if (lane < 0) return null;
            // Any new connection restarts the player's typing rhythm — banked speed
            // survives, sequence progress does not.
            _sim.Lane(lane).SeqProgress = 0;
            _owners[lane] = new LaneOwner(connectionId, userId, isGuest);
            return lane;
        }
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
        // Persist every human lane's meet — guests included (IsGuest rows rank too).
        foreach (var lane in final.Lanes.Where(l => !l.IsAi))
        {
            var owner = _owners.TryGetValue(lane.Lane, out var o) ? o : null;
            var entry = new PoSportsHighScore
            {
                PlayerName = lane.Name,
                UserId = owner?.UserId ?? "",
                IsGuest = owner?.IsGuest ?? true,
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

    public async ValueTask DisposeAsync()
    {
        if (_tick is not null) await _tick.DisposeAsync();
        if (_snap is not null) await _snap.DisposeAsync();
    }
}
