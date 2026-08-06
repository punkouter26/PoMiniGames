using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGamesClient.Services;
using PoMiniGames.Shared.Games;

namespace PoMiniGamesClient.Games.PoSports.Services;

/// <summary>
/// Client-side wrapper around the two PoSports hubs. The lobby connection
/// (<c>/posports/lobby-hub</c>) carries the global room — join, character pick,
/// ready, host start; the race connection (<c>/posports/race-hub</c>) carries the
/// meet itself — 15 Hz snapshots in, sequence keys out. Contracts are the
/// PoMiniGames.Shared.Games records, shared with the server.
/// </summary>
public sealed class PoSportsHubService : IAsyncDisposable
{
    private readonly ApiEndpoints _endpoints;
    private HubConnection? _lobby;
    private HubConnection? _race;
    private readonly List<IDisposable> _subs = [];
    private readonly List<IDisposable> _raceSubs = [];
    private string _displayName = "Player";
    private bool _isGuest = true;
    /// <summary>The race the connection is currently joined to — read by the reconnect handler.</summary>
    private string _raceCode = "";
    private bool _raceAsPlayer;

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

        // Credentials handler + auto-reconnect come baked into the shared
        // factory (see HubConnectionFactory for the §2026-07-16 cookie contract).
        _lobby = HubConnectionFactory.Create(_endpoints.Hub("posports/lobby-hub"));

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

    /// <summary>
    /// Join (or rejoin) a meet. Returns null when the server has no joinable meet for the
    /// code — the caller should send the player back to the lobby. The result carries the
    /// lane the server bound to this connection (-1 for a spectator).
    /// </summary>
    public async Task<PoSportsJoinResult?> JoinRaceAsync(string code, bool asPlayer)
    {
        // Fields, not captured locals: the Reconnected handler is registered once for the
        // connection's life, so a closure over this call's arguments would keep replaying
        // the FIRST race's code and role after any later join.
        _raceCode = code;
        _raceAsPlayer = asPlayer;

        if (_race is null)
        {
            _race = HubConnectionFactory.Create(_endpoints.Hub("posports/race-hub"));

            _raceSubs.Add(_race.On<PoSportsSnapshot>("raceSnapshot", s => SnapshotReceived?.Invoke(s)));
            _raceSubs.Add(_race.On<PoSportsSnapshot>("raceFinished", s => RaceFinished?.Invoke(s)));

            await _race.StartAsync();

            // Rejoin rebinds the lane (sequence progress resets server-side).
            _race.Reconnected += async _ =>
            {
                try { await _race.InvokeAsync<PoSportsJoinResult?>("JoinRace", _raceCode, _raceAsPlayer, _displayName, _isGuest); } catch { }
            };
        }
        return await _race.InvokeAsync<PoSportsJoinResult?>("JoinRace", code, asPlayer, _displayName, _isGuest);
    }

    /// <summary>
    /// Close the race connection when leaving the meet. Without this the socket stays open
    /// for the app's lifetime (the service is scoped, which in WASM means app-lifetime),
    /// still in the server's race group, deserializing 15 Hz snapshots into events nobody
    /// listens to — and SignalR only sheds group membership on disconnect, so a later meet
    /// would also keep receiving the old one's broadcasts.
    /// </summary>
    public async Task StopRaceAsync()
    {
        var race = _race;
        _race = null;
        _raceCode = "";
        _raceAsPlayer = false;
        foreach (var s in _raceSubs) s.Dispose();
        _raceSubs.Clear();
        if (race is not null)
        {
            try { await race.StopAsync(); } catch { }
            try { await race.DisposeAsync(); } catch { }
        }
    }

    /// <summary>Send one sequence key as its layout ordinal (0-3).</summary>
    public Task SendSequenceKeyAsync(string code, int step) =>
        _race?.InvokeAsync("SendSequenceKey", code, step) ?? Task.CompletedTask;

    public Task SendJumpAsync(string code) =>
        _race?.InvokeAsync("SendJump", code) ?? Task.CompletedTask;

    public async ValueTask DisposeAsync()
    {
        await StopRaceAsync();
        foreach (var s in _subs) s.Dispose();
        _subs.Clear();
        if (_lobby is not null) { try { await _lobby.DisposeAsync(); } catch { } }
        _lobby = null;
    }
}
