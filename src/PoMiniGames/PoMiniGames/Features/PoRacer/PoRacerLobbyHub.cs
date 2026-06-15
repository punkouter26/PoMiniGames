using Microsoft.AspNetCore.SignalR;
using PoShared.Games;

namespace PoMiniGames.Features.PoRacer;

public sealed class PoRacerLobbyHub : Hub
{
    private static readonly Dictionary<string, PoRacerLobbyPlayer> _players = new();
    private static readonly object _lock = new();
    private static string? _hostId;

    public override async Task OnConnectedAsync()
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, "poracer-lobby");
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? ex)
    {
        lock (_lock)
        {
            _players.Remove(Context.ConnectionId);
            if (_hostId == Context.ConnectionId)
            {
                _hostId = _players.Keys.FirstOrDefault();
            }
        }
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, "poracer-lobby");
        await BroadcastAsync();
        await base.OnDisconnectedAsync(ex);
    }

    public async Task Join(string displayName, bool isGuest)
    {
        lock (_lock)
        {
            if (_hostId is null)
            {
                _hostId = Context.ConnectionId;
            }
            _players[Context.ConnectionId] = new PoRacerLobbyPlayer(
                ConnectionId: Context.ConnectionId,
                DisplayName: string.IsNullOrWhiteSpace(displayName) ? "Player" : displayName,
                IsGuest: isGuest,
                IsReady: false);
        }
        await BroadcastAsync();
    }

    public async Task ToggleReady()
    {
        lock (_lock)
        {
            if (_players.TryGetValue(Context.ConnectionId, out var existing))
            {
                _players[Context.ConnectionId] = existing with { IsReady = !existing.IsReady };
            }
        }
        await BroadcastAsync();
    }

    public async Task Leave()
    {
        lock (_lock)
        {
            _players.Remove(Context.ConnectionId);
            if (_hostId == Context.ConnectionId)
            {
                _hostId = _players.Keys.FirstOrDefault();
            }
        }
        await BroadcastAsync();
    }

    public async Task StartGame()
    {
        lock (_lock)
        {
            if (Context.ConnectionId != _hostId)
            {
                return;
            }
        }
        await Clients.Group("poracer-lobby").SendAsync("gameStarted");
    }

    private async Task BroadcastAsync()
    {
        PoRacerLobbyState state;
        lock (_lock)
        {
            state = new PoRacerLobbyState(
                Players: _players.Values.OrderBy(p => p.ConnectionId).ToList(),
                HostConnectionId: _hostId,
                LastUpdatedUtc: DateTimeOffset.UtcNow);
        }
        await Clients.Group("poracer-lobby").SendAsync("lobbyState", state);
    }
}
