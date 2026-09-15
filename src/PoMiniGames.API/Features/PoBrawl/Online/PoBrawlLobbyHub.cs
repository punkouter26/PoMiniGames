using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.Shared.Games;
using PoBrawlFighter = PoMiniGames.Domain.Primitives.PoBrawlFighter;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// Lobby hub for the single global PoBrawl 1v1 room. Cap is 2 (host + challenger);
/// a third arrival is bounced by the service. The host picks the Start button when
/// both players are Ready; on Start we spin up the match service immediately
/// (capturing the player list NOW, not on the client's eventual JoinMatch) so the
/// match service has the roster before any WebSocket-reconnect race window opens.
/// </summary>
public sealed class PoBrawlLobbyHub : Hub
{
    private readonly PoBrawlLobbyService _lobby;
    private readonly PoBrawlMatchRegistry _matches;
    private readonly ILogger<PoBrawlLobbyHub> _log;

    private const string Group = "pobrawl-lobby";

    public PoBrawlLobbyHub(
        PoBrawlLobbyService lobby,
        PoBrawlMatchRegistry matches,
        ILogger<PoBrawlLobbyHub> log)
    {
        _lobby = lobby;
        _matches = matches;
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
                new PoBrawlLobbyEvent("left", msg, DateTimeOffset.UtcNow));
        }
        await base.OnDisconnectedAsync(ex);
    }

    /// <summary>
    /// Join the lobby. Server-canonical identity is derived from <c>Context.User</c>
    /// (the auth cookie claims) — the supplied <paramref name="displayName"/> is
    /// only a fallback for genuinely anonymous guests who have nothing to claim.
    /// </summary>
    public async Task<PoBrawlLobbyState> Join(
        string displayName, bool isGuest, string fighterId)
    {
        var identity = RequestIdentity.Resolve(Context.User);
        var name = !string.IsNullOrWhiteSpace(identity.DisplayName)
            ? identity.DisplayName
            : displayName;
        var guest = identity.IsGuest || isGuest;
        // Allow either a rateable president OR Bob (the 1P/2P avatar). Bob cannot
        // appear on the demo Elo board, but the online mode accepts him as a 1v1 pick.
        PoBrawlFighter fighter;
        var canonicalId = PoBrawlRoster.Canonicalize(fighterId);
        if (canonicalId is not null)
        {
            fighter = new PoBrawlFighter(canonicalId, PoBrawlRoster.DisplayName(canonicalId));
        }
        else if (string.Equals(fighterId, PoBrawlRoster.Bob.Id, StringComparison.OrdinalIgnoreCase))
        {
            fighter = PoBrawlRoster.Bob;
        }
        else
        {
            throw new HubException($"'{fighterId}' is not a PoBrawl fighter.");
        }

        var (state, msg) = _lobby.Open(
            Context.ConnectionId, identity.UserId, name, guest, fighter);
        _log.LogInformation(
            "PoBrawl lobby: conn={Conn} joined as {Name}; players={Count} host={Host} fighter={FighterId}",
            Context.ConnectionId, name, state.Players.Count, state.HostConnectionId, fighter.Id);
        await Clients.Group(Group).SendAsync("lobbyState", state);
        await Clients.Group(Group).SendAsync("lobbyEvent",
            new PoBrawlLobbyEvent("joined", msg, DateTimeOffset.UtcNow));
        return state;
    }

    public async Task ToggleReady()
    {
        var (ok, _, msg) = _lobby.ToggleReady(Context.ConnectionId);
        if (!ok) return;
        await Clients.Group(Group).SendAsync("lobbyState", _lobby.State);
        await Clients.Group(Group).SendAsync("lobbyEvent",
            new PoBrawlLobbyEvent("ready", msg, DateTimeOffset.UtcNow));
    }

    public async Task LeaveLobby()
    {
        var (ok, msg) = _lobby.Leave(Context.ConnectionId);
        await Clients.Group(Group).SendAsync("lobbyState", _lobby.State);
        if (ok && !string.IsNullOrEmpty(msg))
        {
            await Clients.Group(Group).SendAsync("lobbyEvent",
                new PoBrawlLobbyEvent("left", msg, DateTimeOffset.UtcNow));
        }
    }

    public async Task StartGame()
    {
        _log.LogInformation("PoBrawl StartGame conn={Conn}", Context.ConnectionId);
        if (!_lobby.TryStart(Context.ConnectionId)) return;
        // Capture the player list NOW. Same reasoning as PoRacer: the match
        // service owns the roster from Start time, not from the clients'
        // eventual JoinMatch, so a 30-second WebSocket timeout between lobby
        // and match can't silently drop one of the two fighters.
        var players = _lobby.Players.ToList();
        await _matches.GetOrCreateAsync(PoBrawlLobbyService.GlobalCode, players);
        await Clients.Group(Group).SendAsync("lobbyEvent",
            new PoBrawlLobbyEvent("starting", "Match starting…", DateTimeOffset.UtcNow));
        await Clients.Group(Group).SendAsync("gameStarted", PoBrawlLobbyService.GlobalCode);
    }
}
