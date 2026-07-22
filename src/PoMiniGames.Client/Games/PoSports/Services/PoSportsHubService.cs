using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGamesClient.Services;
using PoShared.Games;

namespace PoMiniGamesClient.Games.PoSports.Services;

/// <summary>
/// Client-side wrapper around the two PoSports hubs. The lobby connection
/// (<c>/posports/lobby-hub</c>) carries the global room — join, character pick,
/// ready, host start; the race connection (<c>/posports/race-hub</c>) carries the
/// meet itself — 15 Hz snapshots in, sequence keys out. Contracts are the
/// PoShared.Games records, shared with the server.
/// </summary>
public sealed class PoSportsHubService : IAsyncDisposable
{
    private readonly ApiEndpoints _endpoints;
    private HubConnection? _lobby;
    private HubConnection? _race;
    private readonly List<IDisposable> _subs = [];
    private string _displayName = "Player";
    private bool _isGuest = true;

    public event Action<PoSportsLobbyState>? LobbyUpdated;
    public event Action<PoSportsLobbyEvent>? LobbyEvent;
    /// <summary>The host started the meet; payload is the race code to join.</summary>
    public event Action<string>? GameStarted;
    public event Action<PoSportsSnapshot>? SnapshotReceived;
    public event Action<PoSportsSnapshot>? RaceFinished;

    public string LobbyConnectionId => _lobby?.ConnectionId ?? "";

    public PoSportsHubService(ApiEndpoints endpoints) => _endpoints = endpoints;

    // ── Lobby ─────────────────────────────────────────────────────────────

    public async Task<PoSportsLobbyState?> ConnectLobbyAsync(string displayName, bool isGuest)
    {
        _displayName = string.IsNullOrWhiteSpace(displayName) ? "Player" : displayName;
        _isGuest = isGuest;
        if (_lobby is not null) return await _lobby.InvokeAsync<PoSportsLobbyState>("Join", _displayName, _isGuest);

        _lobby = new HubConnectionBuilder()
            .WithUrl(_endpoints.Hub("posports/lobby-hub"), options =>
            {
                // DevAuth cookie must round-trip on the negotiate POST (see PoRacer note).
                options.HttpMessageHandlerFactory = SignalRCredentialsHttpClientFactory.CreateHandler;
            })
            .WithAutomaticReconnect()
            .Build();

        _subs.Add(_lobby.On<PoSportsLobbyState>("lobbyState", s => LobbyUpdated?.Invoke(s)));
        _subs.Add(_lobby.On<PoSportsLobbyEvent>("lobbyEvent", e => LobbyEvent?.Invoke(e)));
        _subs.Add(_lobby.On<string>("gameStarted", code => GameStarted?.Invoke(code)));

        await _lobby.StartAsync();

        // Re-join on every reconnect — the server ran Leave for the old connection id.
        _lobby.Reconnected += async _ =>
        {
            try { await _lobby.InvokeAsync<PoSportsLobbyState>("Join", _displayName, _isGuest); } catch { }
        };

        return await _lobby.InvokeAsync<PoSportsLobbyState>("Join", _displayName, _isGuest);
    }

    public Task<bool> PickCharacterAsync(string character) =>
        _lobby?.InvokeAsync<bool>("PickCharacter", character) ?? Task.FromResult(false);

    public Task ToggleReadyAsync() => _lobby?.InvokeAsync("ToggleReady") ?? Task.CompletedTask;

    public Task StartGameAsync() => _lobby?.InvokeAsync("StartGame") ?? Task.CompletedTask;

    public Task LeaveLobbyAsync() => _lobby?.InvokeAsync("LeaveLobby") ?? Task.CompletedTask;

    // ── Race ──────────────────────────────────────────────────────────────

    public async Task<PoSportsSnapshot?> JoinRaceAsync(string code, bool asPlayer)
    {
        if (_race is null)
        {
            _race = new HubConnectionBuilder()
                .WithUrl(_endpoints.Hub("posports/race-hub"), options =>
                {
                    options.HttpMessageHandlerFactory = SignalRCredentialsHttpClientFactory.CreateHandler;
                })
                .WithAutomaticReconnect()
                .Build();

            _subs.Add(_race.On<PoSportsSnapshot>("raceSnapshot", s => SnapshotReceived?.Invoke(s)));
            _subs.Add(_race.On<PoSportsSnapshot>("raceFinished", s => RaceFinished?.Invoke(s)));

            await _race.StartAsync();

            // Rejoin rebinds the lane (sequence progress resets server-side).
            _race.Reconnected += async _ =>
            {
                try { await _race.InvokeAsync<PoSportsSnapshot?>("JoinRace", code, asPlayer, _displayName, _isGuest); } catch { }
            };
        }
        return await _race.InvokeAsync<PoSportsSnapshot?>("JoinRace", code, asPlayer, _displayName, _isGuest);
    }

    /// <summary>Send one sequence key as its layout ordinal (0-3).</summary>
    public Task SendSequenceKeyAsync(string code, int step) =>
        _race?.InvokeAsync("SendSequenceKey", code, step) ?? Task.CompletedTask;

    public Task SendJumpAsync(string code) =>
        _race?.InvokeAsync("SendJump", code) ?? Task.CompletedTask;

    public async ValueTask DisposeAsync()
    {
        foreach (var s in _subs) s.Dispose();
        _subs.Clear();
        if (_lobby is not null) { try { await _lobby.DisposeAsync(); } catch { } }
        if (_race is not null) { try { await _race.DisposeAsync(); } catch { } }
        _lobby = null;
        _race = null;
    }
}
