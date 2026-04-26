using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;

namespace PoMiniGames.Features.PoRunner;

public class GameSessionManager : IHostedService, IGameSessionManager, IDisposable
{
    private readonly ConcurrentDictionary<string, GameRoom> _rooms = new();
    private readonly ConcurrentDictionary<string, string> _playerToRoomMap = new();
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _pendingRemovals = new();
    private readonly IServiceProvider _serviceProvider;
    private readonly TimeSpan _gracePeriod;
    private readonly TimeSpan _countdownDuration;
    private readonly TimeSpan _maxRaceDuration;
    private readonly PeriodicTimer _periodicTimer = new(TimeSpan.FromMilliseconds(100));
    private Task? _tickTask;
    private CancellationTokenSource? _tickCts;
    private readonly ILogger<GameSessionManager>? _logger;
    private long _roomCounter = 0;

    private static readonly PlayerColor[] _colorOrder =
    [
        PlayerColor.Yellow, PlayerColor.Blue,   PlayerColor.Red,  PlayerColor.Green,
        PlayerColor.Purple, PlayerColor.Orange, PlayerColor.Pink, PlayerColor.Teal
    ];

    public GameSessionManager(IServiceProvider serviceProvider, ILogger<GameSessionManager>? logger = null, IOptions<GameOptions>? options = null, TimeSpan? gracePeriod = null)
    {
        _serviceProvider = serviceProvider;
        _logger = logger;
        var opts = options?.Value ?? new GameOptions();
        _gracePeriod = gracePeriod ?? TimeSpan.FromMilliseconds(opts.GracePeriodMs);
        _countdownDuration = TimeSpan.FromMilliseconds(opts.CountdownDurationMs);
        _maxRaceDuration = TimeSpan.FromMilliseconds(opts.MaxRaceDurationMs);
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _tickCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        _tickTask = RunTickLoopAsync(_tickCts.Token);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _tickCts?.Cancel();
        _periodicTimer.Dispose();
        return _tickTask ?? Task.CompletedTask;
    }

    public void Dispose()
    {
        if (_tickCts is not null && !_tickCts.IsCancellationRequested)
            _tickCts.Cancel();
        _tickCts?.Dispose();
        _periodicTimer.Dispose();
    }

    private async Task RunTickLoopAsync(CancellationToken ct)
    {
        try
        {
            while (await _periodicTimer.WaitForNextTickAsync(ct))
                await ServerTickAsync();
        }
        catch (OperationCanceledException) { }
    }

    private async Task ServerTickAsync()
    {
        try
        {
            using var scope = _serviceProvider.CreateScope();
            var hubContext = scope.ServiceProvider.GetRequiredService<IHubContext<GameHub>>();
            var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            foreach (var room in _rooms.Values)
            {
                bool stateChanged = false;

                if (room.Status == GameStatus.Countdown)
                {
                    if (nowMs >= room.RaceStartTimeMs)
                    {
                        room.Status = GameStatus.Playing;
                        stateChanged = true;
                    }
                }

                if (room.Status == GameStatus.Playing)
                {
                    var elapsedMs = nowMs - room.RaceStartTimeMs;
                    if (elapsedMs >= (long)_maxRaceDuration.TotalMilliseconds)
                    {
                        bool triggered = false;
                        lock (room.FinishLock)
                        {
                            if (room.Status == GameStatus.Playing)
                            {
                                room.Status = GameStatus.GameOver;
                                room.FinishedPlayerId = string.Empty;
                                room.FinishTimeMs = (long)_maxRaceDuration.TotalMilliseconds;
                                triggered = true;
                            }
                        }
                        if (triggered)
                        {
                            await hubContext.Clients.Group(room.RoomId).SendAsync("gameOver", new
                            {
                                winnerId = (string?)null,
                                timeMs = room.FinishTimeMs,
                                players = room.Players,
                                qualifiesForHighScore = false,
                                timedOut = true
                            });
                            continue;
                        }
                    }
                }

                if (stateChanged)
                    await BroadcastRoomState(hubContext, room);
            }
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "[GameSessionManager] Error in server tick");
        }
    }

    private static async Task BroadcastRoomState(IHubContext<GameHub> hubContext, GameRoom room)
    {
        await hubContext.Clients.Group(room.RoomId).SendAsync("gameState", new
        {
            players = room.Players,
            status = room.Status.ToString().ToLowerInvariant(),
            countdownStartTimeMs = room.CountdownStartTimeMs,
            raceStartTimeMs = room.RaceStartTimeMs,
            finishedPlayerId = room.FinishedPlayerId
        });
    }

    public GameRoom? GetRoomForPlayer(string connectionId)
    {
        if (_playerToRoomMap.TryGetValue(connectionId, out var roomId) && _rooms.TryGetValue(roomId, out var room))
            return room;
        return null;
    }

    public (GameRoom Room, bool IsNewRoom) AddPlayer(string connectionId)
    {
        if (_pendingRemovals.TryRemove(connectionId, out var cts))
        {
            cts.Cancel(); cts.Dispose();
        }

        var openRoom = _rooms.Values.FirstOrDefault(r => r.Players.Count < 8 &&
            (r.Status == GameStatus.Waiting || r.Status == GameStatus.ReadyCheck));
        bool isNewRoom = false;

        if (openRoom == null)
        {
            isNewRoom = true;
            var newRoomId = $"Room_{Interlocked.Increment(ref _roomCounter)}";
            openRoom = new GameRoom { RoomId = newRoomId };
            _rooms.TryAdd(newRoomId, openRoom);
        }

        int slotIndex = openRoom.Players.Count;
        var newPlayer = new PlayerState
        {
            Id = connectionId,
            ColorTint = _colorOrder[slotIndex],
            Direction = "east",
            X = 100,
            Y = slotIndex
        };

        openRoom.Players.TryAdd(connectionId, newPlayer);
        _playerToRoomMap.TryAdd(connectionId, openRoom.RoomId);

        if (openRoom.Players.Count >= 2 && openRoom.Status == GameStatus.Waiting)
            openRoom.Status = GameStatus.ReadyCheck;

        return (openRoom, isNewRoom);
    }

    public GameRoom? RemovePlayer(string connectionId)
    {
        if (!_playerToRoomMap.TryGetValue(connectionId, out var roomId) || !_rooms.TryGetValue(roomId, out var room))
            return null;

        bool useGrace = room.Players.Count >= 2
            && room.Status != GameStatus.GameOver
            && room.Status != GameStatus.Playing;

        if (useGrace && _gracePeriod > TimeSpan.Zero)
        {
            var graceCts = new CancellationTokenSource();
            _pendingRemovals[connectionId] = graceCts;

            _ = Task.Delay(_gracePeriod, graceCts.Token).ContinueWith(async t =>
            {
                if (t.IsCanceled) return;
                _pendingRemovals.TryRemove(connectionId, out _);
                ExecuteRemovePlayer(connectionId, roomId, room);

                if (!room.Players.IsEmpty)
                {
                    try
                    {
                        using var scope = _serviceProvider.CreateScope();
                        var hubContext = scope.ServiceProvider.GetRequiredService<IHubContext<GameHub>>();
                        await BroadcastRoomState(hubContext, room);
                    }
                    catch (Exception ex)
                    {
                        _logger?.LogWarning(ex, "[RemovePlayer] Failed to broadcast post-grace state for {ConnectionId}", connectionId);
                    }
                }
            }, TaskScheduler.Default);

            return room;
        }

        ExecuteRemovePlayer(connectionId, roomId, room);
        return room;
    }

    private void ExecuteRemovePlayer(string connectionId, string roomId, GameRoom room)
    {
        _playerToRoomMap.TryRemove(connectionId, out _);
        room.Players.TryRemove(connectionId, out _);

        if (room.Players.IsEmpty)
        {
            _rooms.TryRemove(roomId, out _);
        }
        else
        {
            foreach (var p in room.Players.Values) { p.IsReady = false; }
            if (room.Status != GameStatus.GameOver)
                room.Status = GameStatus.Waiting;
        }
    }

    public void UpdatePlayerState(string connectionId, ClientState clientState)
    {
        var room = GetRoomForPlayer(connectionId);
        if (room == null || room.Status != GameStatus.Playing) return;

        if (room.Players.TryGetValue(connectionId, out var player))
        {
            float targetX = clientState.X;
            float deltaX = targetX - player.X;
            if (deltaX > 60)
            {
                _logger?.LogWarning("[Anti-Cheat] Player {ConnectionId} attempted to move {DeltaX}px. Clamping.", connectionId, deltaX);
                targetX = player.X + 60;
            }
            player.X = targetX;
            player.Y = clientState.Y;
            player.Direction = clientState.Direction;
            player.Action = clientState.Action;
            player.CurrentFrame = clientState.CurrentFrame;
        }
    }

    public bool SetPlayerReady(string connectionId)
    {
        var room = GetRoomForPlayer(connectionId);
        if (room == null || (room.Status != GameStatus.ReadyCheck && room.Status != GameStatus.Waiting)) return false;
        if (room.Players.TryGetValue(connectionId, out var player))
        {
            player.IsReady = true;
            return true;
        }
        return false;
    }

    public bool AllPlayersReady(string roomId)
    {
        if (_rooms.TryGetValue(roomId, out var room))
            return room.Players.Count >= 1 && room.Players.Values.All(p => p.IsReady);
        return false;
    }

    public void StartCountdown(string roomId)
    {
        if (!_rooms.TryGetValue(roomId, out var room)) return;
        room.Status = GameStatus.Countdown;
        room.CountdownStartTimeMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        room.RaceStartTimeMs = room.CountdownStartTimeMs + (long)_countdownDuration.TotalMilliseconds;
        room.FinishedPlayerId = "";
        room.FinishTimeMs = 0;

        var pIds = room.Players.Keys.ToList();
        for (int i = 0; i < pIds.Count; i++)
        {
            if (room.Players.TryGetValue(pIds[i], out var p))
            {
                p.X = 100;
                p.Y = i;
                p.Direction = "east";
                p.IsReady = false;
            }
        }
    }

    public void FinishRace(string connectionId)
    {
        var room = GetRoomForPlayer(connectionId);
        if (room == null) return;

        lock (room.FinishLock)
        {
            if (room.Status == GameStatus.GameOver) return;
            room.Status = GameStatus.GameOver;
            room.FinishedPlayerId = connectionId;
            room.FinishTimeMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - room.RaceStartTimeMs;
        }
    }

    public void ResetAllSessions()
    {
        foreach (var cts in _pendingRemovals.Values) { cts.Cancel(); cts.Dispose(); }
        _pendingRemovals.Clear();
        _rooms.Clear();
        _playerToRoomMap.Clear();
        Interlocked.Exchange(ref _roomCounter, 0);
    }

    public bool RequestRestart(string connectionId)
    {
        var room = GetRoomForPlayer(connectionId);
        if (room == null || room.Status != GameStatus.GameOver) return false;

        foreach (var p in room.Players.Values) { p.IsReady = false; }
        room.HighScoreSubmitted = false;
        room.Status = room.Players.Count >= 2 ? GameStatus.ReadyCheck : GameStatus.Waiting;
        return true;
    }
}