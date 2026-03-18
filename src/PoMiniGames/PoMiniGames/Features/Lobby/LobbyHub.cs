using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Multiplayer;

namespace PoMiniGames.Features.Lobby;

/// <summary>
/// SignalR hub for the pre-game lobby. Players join when they connect and leave when they disconnect.
/// The host (first to join) may call <see cref="StartGame"/> to route all players to a game.
/// </summary>
[Authorize]
public sealed class LobbyHub : Hub
{
    private readonly ILobbyService _lobbyService;
    private readonly ILogger<LobbyHub> _logger;
    private readonly IMultiplayerService _multiplayerService;

    public LobbyHub(ILobbyService lobbyService, ILogger<LobbyHub> logger, IMultiplayerService multiplayerService)
    {
        _lobbyService = lobbyService;
        _logger = logger;
        _multiplayerService = multiplayerService;
    }

    public override async Task OnConnectedAsync()
    {
        if (AuthenticatedUser.TryCreate(Context.User, out var user) && user is not null)
        {
            _logger.LogInformation("Lobby connected: {UserId} ({DisplayName})", user.UserId, user.DisplayName);

            // If a game is already starting, redirect the late joiner instead of adding them to the lobby.
            if (_lobbyService.IsStarting)
            {
                _logger.LogInformation("Late joiner {UserId} redirected to in-progress game '{GameKey}'", user.UserId, _lobbyService.StartingGameKey);
                await Clients.Caller.SendAsync("GameAlreadyStarted", new { gameKey = _lobbyService.StartingGameKey });
            }
            else
            {
                var snapshot = _lobbyService.AddPlayer(user.UserId, user.DisplayName);
                await Clients.All.SendAsync("LobbyUpdated", snapshot);
            }
        }

        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (AuthenticatedUser.TryCreate(Context.User, out var user) && user is not null)
        {
            _logger.LogInformation("Lobby disconnected: {UserId}", user.UserId);
            var snapshot = _lobbyService.RemovePlayer(user.UserId);
            await Clients.All.SendAsync("LobbyUpdated", snapshot);
        }

        await base.OnDisconnectedAsync(exception);
    }

    /// <summary>
    /// Called by the host to start a game for all players currently in the lobby.
    /// </summary>
    public async Task StartGame(string gameKey)
    {
        if (!AuthenticatedUser.TryCreate(Context.User, out var user) || user is null)
        {
            throw new HubException("Not authenticated.");
        }

        if (!_lobbyService.IsHost(user.UserId))
        {
            throw new HubException("Only the host can start the game.");
        }

        if (!SupportedGameKeyFromRegistry(gameKey))
        {
            throw new HubException($"'{gameKey}' is not a supported lobby game.");
        }

        var snapshot = _lobbyService.GetSnapshot();
        if (snapshot.Players.Length < 2)
        {
            throw new HubException("At least 2 players are required to start.");
        }

        _logger.LogInformation("Host {UserId} started game '{GameKey}' from lobby", user.UserId, gameKey);

        // Mark lobby as starting BEFORE broadcast so any connection racing with this
        // broadcast is caught in OnConnectedAsync and redirected rather than seeing a
        // phantom lobby with ghost players.
        _lobbyService.SetStarting(gameKey);

        // Broadcast to all connected lobby clients — each client will navigate to the game page + auto-join
        await Clients.All.SendAsync("GameStarting", new { gameKey });
    }

    private bool SupportedGameKeyFromRegistry(string gameKey) =>
        _multiplayerService.GetSupportedGames()
            .Any(g => string.Equals(g.GameKey, gameKey, StringComparison.OrdinalIgnoreCase)
                      && g.EnabledForQueue);
}

