using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Services.Http;

namespace PoMiniGamesClient.Games.ConnectFive;

/// <summary>
/// Client-side wrapper around the <c>/connectfive/hub</c> connection. Owned by the
/// page for the life of the online session (not DI-registered: one page, one
/// connection, disposed together). Exposes the two server events as C# events and
/// keeps the seat token so a SignalR automatic reconnect re-binds the seat on its
/// own — the page never sees the drop unless the server has already forfeited.
/// </summary>
public sealed class ConnectFiveOnlineClient : IAsyncDisposable
{
    private readonly ApiEndpoints _endpoints;
    private HubConnection? _hub;
    private string? _seatToken;

    public ConnectFiveOnlineClient(ApiEndpoints endpoints) => _endpoints = endpoints;

    /// <summary>A game began (first pairing or rematch). Carries the local seat's colour and token.</summary>
    public event Action<ConnectFiveMatchStart>? MatchStarted;
    /// <summary>Authoritative board after every change.</summary>
    public event Action<ConnectFiveMatchState>? StateChanged;
    /// <summary>Transport-level changes the page may want to surface (reconnecting, closed).</summary>
    public event Action<HubConnectionState>? ConnectionChanged;
    /// <summary>The seat was lost across a reconnect (server forfeited it); the page should re-queue.</summary>
    public event Action? SeatLost;

    public HubConnectionState State => _hub?.State ?? HubConnectionState.Disconnected;

    public async Task ConnectAsync()
    {
        if (_hub is not null) return;
        // Credentials handler, auto-reconnect and the camelCase enum protocol all come
        // from the shared factory — see HubConnectionFactory.
        _hub = HubConnectionFactory.Create(_endpoints.Hub("connectfive/hub"));
        _hub.On<ConnectFiveMatchStart>("matchStarted", start =>
        {
            _seatToken = start.SeatToken;
            MatchStarted?.Invoke(start);
        });
        _hub.On<ConnectFiveMatchState>("state", state => StateChanged?.Invoke(state));
        _hub.Reconnecting += _ =>
        {
            ConnectionChanged?.Invoke(HubConnectionState.Reconnecting);
            return Task.CompletedTask;
        };
        _hub.Reconnected += async _ =>
        {
            ConnectionChanged?.Invoke(HubConnectionState.Connected);
            await RejoinAsync();
        };
        _hub.Closed += _ =>
        {
            ConnectionChanged?.Invoke(HubConnectionState.Disconnected);
            return Task.CompletedTask;
        };
        await _hub.StartAsync();
        ConnectionChanged?.Invoke(_hub.State);
    }

    public Task<ConnectFiveQueueStatus> FindMatchAsync(string displayName, bool isGuest) =>
        Require().InvokeAsync<ConnectFiveQueueStatus>("FindMatch", displayName, isGuest);

    public Task CancelSearchAsync() => Require().InvokeAsync("CancelSearch");

    /// <summary>Drop in a column. A rejected move throws <see cref="HubException"/> with the server's reason.</summary>
    public Task<ConnectFiveMatchState> DropAsync(int col) =>
        Require().InvokeAsync<ConnectFiveMatchState>("Drop", col);

    public Task RequestRematchAsync() => Require().InvokeAsync("RequestRematch");

    public async Task LeaveAsync()
    {
        _seatToken = null;
        if (_hub is null || _hub.State != HubConnectionState.Connected) return;
        try { await _hub.InvokeAsync("Leave"); } catch { /* leaving anyway */ }
    }

    /// <summary>Forget the seat without telling the server (a finished game the player walked away from).</summary>
    public void ForgetSeat() => _seatToken = null;

    private async Task RejoinAsync()
    {
        if (_hub is null || string.IsNullOrEmpty(_seatToken)) return;
        try
        {
            var result = await _hub.InvokeAsync<ConnectFiveRejoinResult?>("Rejoin", _seatToken);
            if (result is null)
            {
                _seatToken = null;
                SeatLost?.Invoke();
                return;
            }
            MatchStarted?.Invoke(result.Start);
            StateChanged?.Invoke(result.State);
        }
        catch
        {
            _seatToken = null;
            SeatLost?.Invoke();
        }
    }

    private HubConnection Require() =>
        _hub ?? throw new InvalidOperationException("ConnectAsync has not been called.");

    public async ValueTask DisposeAsync()
    {
        if (_hub is null) return;
        var hub = _hub;
        _hub = null;
        try { await hub.DisposeAsync(); } catch { /* page is going away */ }
    }
}
