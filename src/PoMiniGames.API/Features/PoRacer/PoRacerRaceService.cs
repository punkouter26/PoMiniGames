using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoRacer;

/// <summary>A serialized 50 Hz simulation loop, broadcasting every 50 ms.</summary>
public sealed class PoRacerRaceService : IAsyncDisposable
{
    private readonly object _gate = new();
    private readonly PoRacerSim _sim;
    private readonly ILogger<PoRacerRaceService> _log;
    private readonly Dictionary<string, PoRacerInput> _inputs = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _owners = new(StringComparer.Ordinal);
    private readonly HashSet<string> _connections = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _stop = new();
    private Task _loop = Task.CompletedTask;
    private DateTimeOffset _lastOccupied = DateTimeOffset.UtcNow;
    private DateTimeOffset? _finishedAt;
    private PoRacerFinalResult? _result;

    public PoRacerRaceService(string code, IReadOnlyList<PoRacerLobbyPlayer> players, ILogger<PoRacerRaceService> log, string? trackId = null)
    {
        GameCode = code;
        _sim = new PoRacerSim(players, trackId);
        _log = log;
    }

    public string GameCode { get; }
    public event Func<PoRacerRaceSnapshot, Task>? SnapshotReady;
    public event Func<PoRacerFinalResult, Task>? Finished;
    public PoRacerStaticWorld GetStaticWorld() => _sim.Static;
    public void Start() => _loop = RunAsync();

    public int? BindPlayer(string connectionId, string userId)
    {
        lock (_gate)
        {
            var carId = _sim.CarIdForOwner(userId);
            if (carId is null) return null;
            foreach (var old in _owners.Where(p => p.Value == userId).Select(p => p.Key).ToArray()) _owners.Remove(old);
            _inputs.Remove(userId);
            _owners[connectionId] = userId;
            return carId;
        }
    }

    public void AddConnection(string connectionId)
    {
        lock (_gate) { _connections.Add(connectionId); _lastOccupied = DateTimeOffset.UtcNow; }
    }

    public void RemoveConnection(string connectionId)
    {
        lock (_gate)
        {
            _connections.Remove(connectionId);
            if (_owners.Remove(connectionId, out var owner)) _inputs.Remove(owner);
            _lastOccupied = DateTimeOffset.UtcNow;
        }
    }

    public void SetInput(string connectionId, PoRacerInput input)
    {
        lock (_gate)
            if (_finishedAt is null && _owners.TryGetValue(connectionId, out var owner)) _inputs[owner] = input;
    }

    public PoRacerRaceSnapshot Snapshot()
    {
        lock (_gate) return _sim.Snapshot(GameCode);
    }

    public PoRacerFinalResult? Result { get { lock (_gate) return _result; } }

    public bool HasExpired(DateTimeOffset now)
    {
        lock (_gate)
            return _finishedAt is { } finished ? now - finished > TimeSpan.FromSeconds(30)
                : _connections.Count == 0 && now - _lastOccupied > TimeSpan.FromSeconds(30);
    }

    private async Task RunAsync()
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(20));
        var snapshotElapsed = 0;
        try
        {
            while (await timer.WaitForNextTickAsync(_stop.Token))
            {
                PoRacerFinalResult? result;
                PoRacerRaceSnapshot? snapshot = null;
                lock (_gate)
                {
                    _sim.Tick(0.02, _inputs);
                    result = _sim.AllFinishedOrStopped() ? _sim.BuildFinalResult(GameCode) : null;
                    snapshotElapsed += 20;
                    if (snapshotElapsed >= 50 || result is not null)
                    {
                        snapshotElapsed %= 50;
                        snapshot = _sim.Snapshot(GameCode);
                    }
                    if (result is not null) { _result = result; _finishedAt = DateTimeOffset.UtcNow; }
                }
                if (snapshot is not null && SnapshotReady is { } onSnapshot) await onSnapshot(snapshot);
                if (result is not null)
                {
                    if (Finished is { } onFinished) await onFinished(result);
                    break;
                }
            }
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
        catch (Exception ex)
        {
            lock (_gate) _finishedAt = DateTimeOffset.UtcNow;
            _log.LogError(ex, "Race {Code} stopped unexpectedly", GameCode);
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _stop.CancelAsync();
        await _loop;
        SnapshotReady = null;
        Finished = null;
        _stop.Dispose();
    }
}
