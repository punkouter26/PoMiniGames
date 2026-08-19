using Microsoft.AspNetCore.SignalR;

namespace PoMiniGames.Features.PoVoxelStrike;

/// <summary>
/// Lobby hub for the single global PoVoxelStrike room. Connecting to this hub and
/// calling <see cref="Join"/> puts the connection into the lobby. The host is the
/// first arrival; subsequent arrivals join until the cap (<c>MaxPlayers = 6</c>) is
/// reached. When everyone is Ready and the host calls <see cref="StartGame"/>, the
/// hub returns the game code so the client can switch to the lockstep hub.
/// </summary>
public sealed class PoVoxelStrikeLobbyHub : Hub
{
    private const string Group = "povoxelstrike-lobby";
    private readonly PoVoxelStrikeLobbyService _lobby;
    private readonly PoVoxelStrikeLockstepService _lockstep;
    private readonly ILogger<PoVoxelStrikeLobbyHub> _log;

    public PoVoxelStrikeLobbyHub(
        PoVoxelStrikeLobbyService lobby,
        PoVoxelStrikeLockstepService lockstep,
        ILogger<PoVoxelStrikeLobbyHub> log)
    {
        _lobby = lobby;
        _lockstep = lockstep;
        _log = log;
    }

    public override async Task OnConnectedAsync()
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, Group);
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? ex)
    {
        var (ok, msg) = _lobby.Leave(Context.ConnectionId);
        await Clients.Group(Group).SendAsync("lobbyState", _lobby.State);
        if (ok && !string.IsNullOrEmpty(msg))
        {
            await Clients.Group(Group).SendAsync("lobbyEvent",
                new PoMiniGames.Shared.Games.PoVoxelStrikeLobbyEvent("left", msg, DateTimeOffset.UtcNow));
        }
        // Drop any in-flight lockstep session this connection was driving.
        _lockstep.RemoveConnection(Context.ConnectionId);
        await base.OnDisconnectedAsync(ex);
    }

    /// <summary>Join the global lobby. First arrival becomes host.</summary>
    public async Task<PoMiniGames.Shared.Games.PoVoxelStrikeLobbyState> Join(string displayName, bool isGuest)
    {
        var (state, msg) = _lobby.Open(Context.ConnectionId, displayName, isGuest);
        _log.LogInformation("PoVoxelStrike lobby: conn={Conn} joined as {Name}; players={Count}/{Max} host={Host}",
            Context.ConnectionId, displayName, state.Players.Count, state.MaxPlayers, state.HostConnectionId);
        await Clients.Group(Group).SendAsync("lobbyState", state);
        await Clients.Group(Group).SendAsync("lobbyEvent",
            new PoMiniGames.Shared.Games.PoVoxelStrikeLobbyEvent("joined", msg, DateTimeOffset.UtcNow));
        return state;
    }

    public async Task ToggleReady()
    {
        // The service flips under its own lock and reports the state it stored — announcing
        // a pre-toggle snapshot read outside the lock inverted every ready/not-ready toast.
        var (ok, _, msg) = _lobby.ToggleReady(Context.ConnectionId);
        if (!ok) return;
        await Clients.Group(Group).SendAsync("lobbyState", _lobby.State);
        await Clients.Group(Group).SendAsync("lobbyEvent",
            new PoMiniGames.Shared.Games.PoVoxelStrikeLobbyEvent("ready", msg, DateTimeOffset.UtcNow));
    }

    public async Task LeaveLobby()
    {
        var (ok, msg) = _lobby.Leave(Context.ConnectionId);
        await Clients.Group(Group).SendAsync("lobbyState", _lobby.State);
        if (ok && !string.IsNullOrEmpty(msg))
        {
            await Clients.Group(Group).SendAsync("lobbyEvent",
                new PoMiniGames.Shared.Games.PoVoxelStrikeLobbyEvent("left", msg, DateTimeOffset.UtcNow));
        }
    }

    public async Task StartGame()
    {
        if (!_lobby.TryStart(Context.ConnectionId)) return;
        // Spin up the lockstep session IMMEDIATELY (capturing the current player list) so
        // the runtime has the players at StartGame time — not at the client's eventual
        // JoinLockstep call, by which point the SignalR WebSocket may have reconnected
        // (60s client timeout) and cleared the lobby.
        _lockstep.GetOrCreateSession(PoVoxelStrikeLobbyService.GlobalCode, _lobby.Players);
        await Clients.Group(Group).SendAsync("lobbyEvent",
            new PoMiniGames.Shared.Games.PoVoxelStrikeLobbyEvent("starting", "Run starting…", DateTimeOffset.UtcNow));
        await Clients.Group(Group).SendAsync("gameStarted", PoVoxelStrikeLobbyService.GlobalCode);
    }
}
