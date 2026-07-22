using Microsoft.AspNetCore.SignalR;
using PoShared.Games;

namespace PoMiniGames.Features.PoSports;

/// <summary>
/// Lobby hub for the single global PoSports room, mirroring
/// <see cref="PoRacer.PoRacerLobbyHub"/>: first arrival is host, members pick a
/// distinct family character, everyone readies up, and the host starts the meet.
/// </summary>
public sealed class PoSportsLobbyHub : Hub
{
    private readonly PoSportsLobbyService _lobby;
    private readonly ILogger<PoSportsLobbyHub> _log;

    private const string Group = "posports-lobby";

    public PoSportsLobbyHub(PoSportsLobbyService lobby, ILogger<PoSportsLobbyHub> log)
    {
        _lobby = lobby;
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
            await Clients.Group(Group).SendAsync("lobbyEvent", new PoSportsLobbyEvent("left", msg, DateTimeOffset.UtcNow));
        }
        await base.OnDisconnectedAsync(ex);
    }

    /// <summary>Join the global lobby. First arrival becomes host.</summary>
    public async Task<PoSportsLobbyState> Join(string displayName, bool isGuest)
    {
        var (state, msg) = _lobby.Open(Context.ConnectionId, displayName, isGuest);
        _log.LogInformation("PoSports lobby: conn={Conn} joined as {Name}; members={Count} host={Host}",
            Context.ConnectionId, displayName, state.Members.Count, state.HostConnectionId);
        await Clients.Group(Group).SendAsync("lobbyState", state);
        await Clients.Group(Group).SendAsync("lobbyEvent",
            new PoSportsLobbyEvent("joined", msg, DateTimeOffset.UtcNow));
        return state;
    }

    /// <summary>Claim a character (first-come lock). Returns false when it is taken.</summary>
    public async Task<bool> PickCharacter(string character)
    {
        var (ok, msg) = _lobby.PickCharacter(Context.ConnectionId, character);
        await Clients.Group(Group).SendAsync("lobbyState", _lobby.State);
        if (!string.IsNullOrEmpty(msg))
        {
            await Clients.Group(Group).SendAsync("lobbyEvent",
                new PoSportsLobbyEvent(ok ? "pick" : "pick-denied", msg, DateTimeOffset.UtcNow));
        }
        return ok;
    }

    public async Task ToggleReady()
    {
        var m = _lobby.Members.FirstOrDefault(x => x.ConnectionId == Context.ConnectionId);
        if (m is null) return;
        _lobby.SetReady(Context.ConnectionId, !m.IsReady);
        await Clients.Group(Group).SendAsync("lobbyState", _lobby.State);
        await Clients.Group(Group).SendAsync("lobbyEvent",
            new PoSportsLobbyEvent("ready", $"{m.DisplayName} is {(m.IsReady ? "ready" : "not ready")}", DateTimeOffset.UtcNow));
    }

    public async Task LeaveLobby()
    {
        var (ok, msg) = _lobby.Leave(Context.ConnectionId);
        await Clients.Group(Group).SendAsync("lobbyState", _lobby.State);
        if (ok && !string.IsNullOrEmpty(msg))
        {
            await Clients.Group(Group).SendAsync("lobbyEvent", new PoSportsLobbyEvent("left", msg, DateTimeOffset.UtcNow));
        }
    }

    /// <summary>
    /// Host-only. Requires everyone Ready with a character picked. The race itself is
    /// created by the race registry when clients call JoinRace on the race hub; this
    /// broadcast only moves everyone to the race page. (The registry hook lands with
    /// the race feature — see PoSportsRaceRegistry.)
    /// </summary>
    public async Task StartGame()
    {
        if (!_lobby.TryStart(Context.ConnectionId)) return;
        await Clients.Group(Group).SendAsync("lobbyEvent",
            new PoSportsLobbyEvent("starting", "Meet starting…", DateTimeOffset.UtcNow));
        await Clients.Group(Group).SendAsync("gameStarted", PoSportsLobbyService.GlobalCode);
    }
}
