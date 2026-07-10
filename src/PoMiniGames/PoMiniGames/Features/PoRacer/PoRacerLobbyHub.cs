using Microsoft.AspNetCore.SignalR;
using PoShared.Games;

namespace PoMiniGames.Features.PoRacer;

/// <summary>
/// Lobby hub for the single global PoRacer room. Connecting to this hub and
/// calling <see cref="Join"/> puts the connection into the lobby — the host
/// is the first arrival; subsequent arrivals join as players and the host's
/// Start button waits for everyone to toggle Ready.
/// </summary>
public sealed class PoRacerLobbyHub : Hub
{
    private readonly PoRacerLobbyService _lobby;
    private readonly PoRacerRaceRegistry _races;
    private readonly ILogger<PoRacerLobbyHub> _log;

    private const string Group = "poracer-lobby";

    public PoRacerLobbyHub(PoRacerLobbyService lobby, PoRacerRaceRegistry races, ILogger<PoRacerLobbyHub> log)
    {
        _lobby = lobby;
        _races = races;
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
            await Clients.Group(Group).SendAsync("lobbyEvent", new PoRacerLobbyEvent("left", msg, DateTimeOffset.UtcNow));
        }
        _races.RemoveInput(Context.ConnectionId);
        await base.OnDisconnectedAsync(ex);
    }

    /// <summary>Join the global lobby. First arrival becomes host.</summary>
    public async Task<PoRacerLobbyState> Join(string displayName, bool isGuest)
    {
        var (state, msg) = _lobby.Open(Context.ConnectionId, displayName, isGuest);
        _log.LogInformation("PoRacer lobby: conn={Conn} joined as {Name}; players={Count} host={Host}",
            Context.ConnectionId, displayName, state.Players.Count, state.HostConnectionId);
        await Clients.Group(Group).SendAsync("lobbyState", state);
        await Clients.Group(Group).SendAsync("lobbyEvent",
            new PoRacerLobbyEvent("joined", msg, DateTimeOffset.UtcNow));
        return state;
    }

    public async Task ToggleReady()
    {
        var p = _lobby.Players.FirstOrDefault(x => x.ConnectionId == Context.ConnectionId);
        if (p is null) return;
        _lobby.SetReady(Context.ConnectionId, !p.IsReady);
        await Clients.Group(Group).SendAsync("lobbyState", _lobby.State);
        await Clients.Group(Group).SendAsync("lobbyEvent",
            new PoRacerLobbyEvent("ready", $"{p.DisplayName} is {(p.IsReady ? "ready" : "not ready")}", DateTimeOffset.UtcNow));
    }

    public async Task LeaveLobby()
    {
        var (ok, msg) = _lobby.Leave(Context.ConnectionId);
        await Clients.Group(Group).SendAsync("lobbyState", _lobby.State);
        if (ok && !string.IsNullOrEmpty(msg))
        {
            await Clients.Group(Group).SendAsync("lobbyEvent", new PoRacerLobbyEvent("left", msg, DateTimeOffset.UtcNow));
        }
    }

    public async Task StartGame()
    {
        if (!_lobby.TryStart(Context.ConnectionId)) return;
        // Spin up the race IMMEDIATELY (capturing the current player list) so
        // the race registry has the players at StartGame time — not at the
        // client's eventual JoinRace call, by which point the SignalR WebSocket
        // may have reconnected (60s client timeout) and cleared the lobby.
        await _races.GetOrCreateAsync(PoRacerLobbyService.GlobalCode);
        await Clients.Group(Group).SendAsync("lobbyEvent",
            new PoRacerLobbyEvent("starting", "Race starting…", DateTimeOffset.UtcNow));
        await Clients.Group(Group).SendAsync("gameStarted", PoRacerLobbyService.GlobalCode);
    }
}