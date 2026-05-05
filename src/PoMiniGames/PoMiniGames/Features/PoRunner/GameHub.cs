using Microsoft.AspNetCore.SignalR;

namespace PoMiniGames.Features.PoRunner;

public class GameHub : Hub
{
    private readonly IGameSessionManager _sessionManager;
    private readonly ILogger<GameHub> _logger;

    public GameHub(IGameSessionManager sessionManager, ILogger<GameHub> logger)
    {
        _sessionManager = sessionManager;
        _logger = logger;
    }

    public override async Task OnConnectedAsync()
    {
        _logger.LogInformation("[Socket] User connected: {ConnectionId}", Context.ConnectionId);

        var (room, _) = _sessionManager.AddPlayer(Context.ConnectionId);
        await Groups.AddToGroupAsync(Context.ConnectionId, room.RoomId);
        await Clients.Group(room.RoomId).SendAsync("gameState", BuildStatePayload(room));
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        _logger.LogInformation("[Socket] User disconnected: {ConnectionId}", Context.ConnectionId);

        var room = _sessionManager.RemovePlayer(Context.ConnectionId);
        if (room != null)
        {
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, room.RoomId);
            await Clients.Group(room.RoomId).SendAsync("gameState", BuildStatePayload(room));
        }

        await base.OnDisconnectedAsync(exception);
    }

    public async Task PlayerReady()
    {
        var room = _sessionManager.GetRoomForPlayer(Context.ConnectionId);
        if (room == null) { await Clients.Caller.SendAsync("error", "Not in a room."); return; }

        if (!_sessionManager.SetPlayerReady(Context.ConnectionId))
        {
            await Clients.Caller.SendAsync("error", $"Cannot ready up in status '{room.Status}'.");
            return;
        }

        if (_sessionManager.AllPlayersReady(room.RoomId))
            _sessionManager.StartCountdown(room.RoomId);

        await Clients.Group(room.RoomId).SendAsync("gameState", BuildStatePayload(room));
    }

    public async Task SoloReady()
    {
        var room = _sessionManager.GetRoomForPlayer(Context.ConnectionId);
        if (room == null) { await Clients.Caller.SendAsync("error", "Not in a room."); return; }

        if (room.Status != GameStatus.Waiting && room.Status != GameStatus.ReadyCheck)
        {
            await Clients.Caller.SendAsync("error", $"Cannot start solo race in status '{room.Status}'.");
            return;
        }

        foreach (var p in room.Players.Values) p.IsReady = true;
        _sessionManager.StartCountdown(room.RoomId);

        var payload = BuildStatePayload(room);
        await Clients.Caller.SendAsync("gameState", payload);
        await Clients.OthersInGroup(room.RoomId).SendAsync("gameState", payload);
    }

    public async Task PlayerUpdate(ClientState clientState)
    {
        _sessionManager.UpdatePlayerState(Context.ConnectionId, clientState);
        var room = _sessionManager.GetRoomForPlayer(Context.ConnectionId);
        if (room != null)
            await Clients.Group(room.RoomId).SendAsync("gameState", BuildStatePayload(room));
    }

    public async Task PlayerFinished()
    {
        var room = _sessionManager.GetRoomForPlayer(Context.ConnectionId);
        if (room == null || room.Status == GameStatus.GameOver) return;

        _sessionManager.FinishRace(Context.ConnectionId);
        if (room.FinishedPlayerId != Context.ConnectionId) return;

        await Clients.Group(room.RoomId).SendAsync("gameOver", new
        {
            winnerId = room.FinishedPlayerId,
            timeMs = room.FinishTimeMs,
            players = room.Players,
            qualifiesForHighScore = false,
            timedOut = false
        });
    }

    public async Task SubmitHighScore(string initials)
    {
        var room = _sessionManager.GetRoomForPlayer(Context.ConnectionId);
        if (room == null || room.Status != GameStatus.GameOver)
        { await Clients.Caller.SendAsync("error", "Cannot submit score: game is not over."); return; }
        if (room.FinishedPlayerId != Context.ConnectionId)
        { await Clients.Caller.SendAsync("error", "Only the winner can submit a high score."); return; }

        var sanitized = new string((initials ?? "").ToUpperInvariant().Where(char.IsLetter).Take(3).ToArray());
        if (sanitized.Length != 3)
        { await Clients.Caller.SendAsync("error", "Initials must be exactly 3 letters (A-Z)."); return; }

        // Thread-safe check-and-set to prevent duplicate submissions from concurrent calls
        lock (room.FinishLock)
        {
            if (room.HighScoreSubmitted) return;
            room.HighScoreSubmitted = true;
        }

        _logger.LogInformation("[Socket] High score submitted: {TimeMs}ms for \"{Initials}\"", room.FinishTimeMs, sanitized);

        // Acknowledge submission to the client
        await Clients.Caller.SendAsync("highScoreSubmitted", sanitized);
    }

    public async Task RequestRestart()
    {
        if (_sessionManager.RequestRestart(Context.ConnectionId))
        {
            var room = _sessionManager.GetRoomForPlayer(Context.ConnectionId);
            if (room != null)
                await Clients.Group(room.RoomId).SendAsync("gameState", BuildStatePayload(room));
        }
    }

    private static object BuildStatePayload(GameRoom room) => new
    {
        players = room.Players,
        status = room.Status.ToString().ToLowerInvariant(),
        countdownStartTimeMs = room.CountdownStartTimeMs,
        raceStartTimeMs = room.RaceStartTimeMs,
        finishedPlayerId = room.FinishedPlayerId
    };
}
