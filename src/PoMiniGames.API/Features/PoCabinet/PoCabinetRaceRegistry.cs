using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// Owns every in-progress PoCabinet race on this host. One
/// <see cref="PoCabinetSim"/> per <c>gameCode</c>, ticked at 30 Hz by a single
/// shared timer, with per-connection input stored as a thread-local dictionary
/// the sim reads. Hub callers attach / detach without ever holding the sim lock.
///
/// <para>
/// The 30 Hz timer reads <see cref="PoCabinetSim.Tick(double, IReadOnlyDictionary{string, PoCabinetInput})"/>
/// and broadcasts the resulting <see cref="PoCabinetRaceSnapshot"/> over the
/// <c>race:{gameCode}</c> SignalR group. Sessions that finish naturally or
/// reach the safety cap are disposed; abandoned connections fall out of the
/// input dictionary and the next snapshot simply reports no progress for them.
/// </para>
/// </summary>
public sealed class PoCabinetRaceRegistry : IAsyncDisposable
{
    private const int TickHz = 30;

    private readonly Dictionary<string, SimSession> _sessions = new(StringComparer.OrdinalIgnoreCase);
    private readonly IHubContext<PoCabinetRaceHub> _hub;
    private readonly Timer _timer;
    private readonly ILogger<PoCabinetRaceRegistry> _logger;
    private readonly object _createLock = new();
    private bool _disposed;

    public PoCabinetRaceRegistry(
        IHubContext<PoCabinetRaceHub> hub,
        ILogger<PoCabinetRaceRegistry> logger)
    {
        _hub = hub;
        _logger = logger;
        _timer = new Timer(_ => TickAll(), null, TimeSpan.FromMilliseconds(1000 / TickHz), TimeSpan.FromMilliseconds(1000 / TickHz));
    }

    /// <summary>Create (if absent) a race session bound to <paramref name="gameCode"/>.</summary>
    public void EnsureSession(string gameCode, string trackId, IReadOnlyList<PoCabinetDriver> drivers)
    {
        lock (_createLock)
        {
            if (_sessions.ContainsKey(gameCode)) return;
            var sim = new PoCabinetSim(trackId, seed: Environment.TickCount, drivers);
            _sessions[gameCode] = new SimSession(sim);
            _logger.LogInformation("PoCabinet race {Code} created with {Count} drivers on {Track}",
                gameCode, drivers.Count, trackId);
        }
    }

    public void AttachConnection(string gameCode, string connectionId)
    {
        if (!_sessions.TryGetValue(gameCode, out var session)) return;
        session.Connections[connectionId] = DateTimeOffset.UtcNow;
    }

    public void DetachConnection(string connectionId)
    {
        foreach (var (_, session) in _sessions)
        {
            session.Connections.Remove(connectionId);
            session.Inputs.Remove(connectionId);
        }
    }

    public void SubmitIntent(string gameCode, string connectionId, PoCabinetInput input)
    {
        if (!_sessions.TryGetValue(gameCode, out var session)) return;
        session.Inputs[connectionId] = input;
    }

    public async Task SendSnapshotAsync(string gameCode, string connectionId)
    {
        if (!_sessions.TryGetValue(gameCode, out var session)) return;
        var snap = BuildSnapshot(session, connectionId);
        await _hub.Clients.Client(connectionId).SendAsync("RaceSnapshot", snap);
    }

    private void TickAll()
    {
        if (_disposed) return;
        // Snapshot the session list under the lock so a Start/Dispose racing us doesn't
        // trip the "Collection was modified" InvalidOperationException.
        List<(string code, SimSession session)>? snapshot = null;
        lock (_createLock)
        {
            if (_sessions.Count == 0) return;
            snapshot = _sessions.Select(kv => (kv.Key, kv.Value)).ToList();
        }
        foreach (var (code, session) in snapshot!)
        {
            try
            {
                var dt = 1.0 / TickHz;
                session.Sim.Tick(dt, session.Inputs);
                if (session.Sim.IsFinished)
                {
                    _logger.LogInformation("PoCabinet race {Code} finished; disposing", code);
                    _ = _hub.Clients.Group($"race:{code}").SendAsync("RaceFinished", code);
                    lock (_createLock) { _sessions.Remove(code); }
                    continue;
                }
                // Broadcast the snapshot to the whole group; clients that haven't joined
                // receive nothing (they're not in the group).
                var snapshotDto = BuildSnapshot(session, localCarId: null);
                _ = _hub.Clients.Group($"race:{code}").SendAsync("RaceSnapshot", snapshotDto);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "PoCabinet tick for {Code} failed", code);
            }
        }
    }

    private static PoCabinetRaceSnapshot BuildSnapshot(SimSession session, string? localCarId)
    {
        var cars = session.Sim.SnapshotCars().Select(c => new PoCabinetCarState
        {
            Id = c.Id,
            Name = c.Name,
            OfficialId = OfficialIdFor(c.OwnerId),
            Color = c.Color,
            ColorDark = c.Color, // sim doesn't carry ColorDark; client tints locally
            X = c.Pos.X,
            Y = c.Pos.Y,
            Heading = c.Heading,
            SpeedKmh = c.Speed * 3.6, // server stores world units / s; client wants km/h
            Lap = c.Lap,
            LapProgress = c.DistanceAlongTrack,
            Position = c.Id + 1, // computed properly by client-side rank; placeholder
            IsPlayer = c.IsPlayer,
            Finished = c.Lap > session.Sim.TotalLaps,
        }).ToList();

        return new PoCabinetRaceSnapshot
        {
            GameCode = session.Sim.TrackId, // populated client-side from static world
            Cars = cars,
            Started = true,
            Finished = session.Sim.IsFinished,
            LocalCarId = localCarId is null ? null : session.Sim.CarIdForOwner(localCarId),
        };
    }

    /// <summary>Reverse-lookup of an AI official's id from the seeded connection id (bot-N).</summary>
    private static string OfficialIdFor(string ownerId)
    {
        // Driver rows use "bot-0" .. "bot-3" for the four officials, matching the order
        // the racing service spawns them. The racing service (T7) is responsible for
        // constructing the drivers list; this is the contract that links them.
        return ownerId switch
        {
            "bot-0" => "sean-s",
            "bot-1" => "steve-b",
            "bot-2" => "bill-b",
            "bot-3" => "mike-p",
            _ => "player",
        };
    }

    private sealed class SimSession
    {
        public SimSession(PoCabinetSim sim)
        {
            Sim = sim;
            Connections = new Dictionary<string, DateTimeOffset>(StringComparer.Ordinal);
            Inputs = new Dictionary<string, PoCabinetInput>(StringComparer.Ordinal);
        }
        public PoCabinetSim Sim { get; }
        public Dictionary<string, DateTimeOffset> Connections { get; }
        public Dictionary<string, PoCabinetInput> Inputs { get; }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        await _timer.DisposeAsync();
        foreach (var session in _sessions.Values) session.Sim.SnapshotCars(); // no-op dispose
        _sessions.Clear();
    }
}
