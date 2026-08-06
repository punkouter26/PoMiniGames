using System.Collections.Concurrent;
using System.Diagnostics;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoRacer;

/// <summary>
/// Server-authoritative PoRacer race. Holds a track, a list of cars, an
/// input buffer per player, and a <see cref="System.Threading.Timer"/>
/// running the simulation at 50 Hz. Pushes a 20 Hz snapshot to all
/// connected clients in the race's SignalR group.
/// </summary>
public sealed class PoRacerRaceService : IAsyncDisposable
{
    /// <summary>50 Hz sim is smooth enough for collision resolution without runaway CPU.</summary>
    private const int TickHz = 50;
    /// <summary>20 Hz snapshot is plenty for the rendered framerate.</summary>
    private const int SnapshotHz = 20;
    /// <summary>Pre-race countdown so all clients hit GO simultaneously.
    /// §2026-07-17: set to 0 — the 3-2-1 overlay was an extra click the
    /// racer player never asked for. Race starts the instant they join.</summary>
    private const int CountdownMs = 0;

    private readonly string _gameCode;
    private readonly PoRacerLobbyService _lobby;
    private readonly ILogger<PoRacerRaceService> _log;
    private readonly Timer _tick;
    private readonly Timer _snap;

    private readonly object _stateLock = new();
    private readonly PoRacerSim _sim;

    private readonly ConcurrentDictionary<string, PoRacerInput> _inputs = new();

    private int _countdownMs;
    private bool _finishedBroadcast;

    public string GameCode => _gameCode;
    public event Action<PoRacerRaceSnapshot>? SnapshotReady;
    public event Action<PoRacerFinalResult>? Finished;

    public PoRacerRaceService(string gameCode, IReadOnlyList<PoRacerLobbyPlayer> players, PoRacerLobbyService lobby, ILogger<PoRacerRaceService> log)
    {
        _gameCode = gameCode;
        _lobby = lobby;
        _log = log;
        _sim = new PoRacerSim(players);
        _countdownMs = CountdownMs;
        _tick = new Timer(_ => TickSafe(), null, TimeSpan.FromMilliseconds(1000.0 / TickHz), TimeSpan.FromMilliseconds(1000.0 / TickHz));
        _snap = new Timer(_ => SnapshotSafe(), null, TimeSpan.FromMilliseconds(1000.0 / SnapshotHz), TimeSpan.FromMilliseconds(1000.0 / SnapshotHz));
    }

    public PoRacerStaticWorld GetStaticWorld() => _sim.Static;

    public void SetInput(string connectionId, PoRacerInput input)
    {
        if (!_sim.OwnedBy(connectionId)) return;
        _inputs[connectionId] = input;
    }

    public void RemoveInput(string connectionId)
    {
        _inputs.TryRemove(connectionId, out _);
    }

    private void TickSafe()
    {
        try
        {
            bool finished;
            PoRacerFinalResult? result = null;
            lock (_stateLock)
            {
                if (_countdownMs > 0)
                {
                    // Hold the grid until GO — the sim is NOT advanced during the
                    // countdown, so bots no longer take off before "3·2·1".
                    _countdownMs = Math.Max(0, _countdownMs - (int)(1000.0 / TickHz));
                    if (_countdownMs == 0) _sim.StartRacing();  // rebase the race clock to 0 at GO
                }
                else
                {
                    // ConcurrentDictionary reads are lock-free and enumeration is snapshot-safe,
                    // so the sim reads live inputs directly — no per-tick copy at 50Hz.
                    _sim.Tick(1.0 / TickHz, _inputs);
                    finished = !_finishedBroadcast && _sim.AllFinishedOrStopped();
                    if (finished)
                    {
                        _finishedBroadcast = true;
                        result = _sim.BuildFinalResult(_gameCode);
                    }
                }
            }
            if (result is not null)
            {
                // Reset the lobby so the next race needs a fresh Ready round.
                _lobby.EndRace();
                Finished?.Invoke(result);
            }
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "PoRacer race tick failed");
        }
    }

    private void SnapshotSafe()
    {
        try
        {
            PoRacerRaceSnapshot snap;
            lock (_stateLock)
            {
                snap = _sim.Snapshot(_gameCode, _countdownMs);
            }
            SnapshotReady?.Invoke(snap);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "PoRacer race snapshot failed");
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _tick.DisposeAsync();
        await _snap.DisposeAsync();
    }
}
