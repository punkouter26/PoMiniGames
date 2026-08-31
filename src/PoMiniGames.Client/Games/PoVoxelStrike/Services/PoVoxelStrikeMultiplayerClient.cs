using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Services;

namespace PoMiniGamesClient.Games.PoVoxelStrike.Services;

/// <summary>
/// Client-side wrapper around the two PoVoxelStrike multiplayer hubs:
/// <list type="bullet">
/// <item><c>/povoxelstrike/lobby-hub</c> — single global room; join/ready/start. Mirrors
/// PoRacer/PoFunQuiz/PoSports lobby hubs exactly.</item>
/// <item><c>/povoxelstrike/lockstep-hub</c> — active run; relays inputs from the local
/// player to the server, surfaces incoming frames from peers, and forwards heartbeats
/// so the server can flag desync.</item>
/// </list>
/// </summary>
/// <remarks>
/// <para>The lockstep runtime uses a strict ordering contract: every client observes
/// every input batch in PlayerNumber order, then applies them locally. There is no
/// authoritative sim — the server only relays inputs. Determinism is the client's
/// responsibility; the server-side validation is "did your fingerprint match the
/// aggregate the server stamped on this frame?".</para>
///
/// <para>The wrapper deliberately keeps the lobby and lockstep connections separate
/// (mirrors PoSports): the lobby closes before the lockstep opens, the lockstep
/// closes before the lobby reopens on game-over.</para>
/// </remarks>
public sealed class PoVoxelStrikeMultiplayerClient : IAsyncDisposable
{
    private readonly ApiEndpoints _endpoints;
    private HubConnection? _lobby;
    private HubConnection? _lockstep;
    private readonly List<IDisposable> _lobbySubs = new();
    private readonly List<IDisposable> _lockstepSubs = new();
    private string _displayName = "Player";
    private bool _isGuest = true;
    /// <summary>The game code this connection is bound to; surfaced for the lockstep reconnect handler.</summary>
    private string _gameCode = "";

    public event Action<PoVoxelStrikeLobbyState>? LobbyUpdated;
    public event Action<PoVoxelStrikeLobbyEvent>? LobbyEvent;
    public event Action<string>? GameStarted;
    /// <summary>One tick of authoritative state; the engine applies each batch in order.</summary>
    public event Action<PoVoxelStrikeLockstepFrame>? FrameReceived;
    /// <summary>A peer dropped; payload is the connection id (informational only).</summary>
    public event Action<string>? PlayerDropped;
    /// <summary>The host ended the run; payload is empty.</summary>
    public event Action? RunEnded;

    public string LobbyConnectionId => _lobby?.ConnectionId ?? "";

    public PoVoxelStrikeMultiplayerClient(ApiEndpoints endpoints) => _endpoints = endpoints;

    // ── Lobby ─────────────────────────────────────────────────────────────

    public async Task<PoVoxelStrikeLobbyState?> ConnectLobbyAsync(string displayName, bool isGuest)
    {
        _displayName = string.IsNullOrWhiteSpace(displayName) ? "Player" : displayName;
        _isGuest = isGuest;
        if (_lobby is not null) return await _lobby.InvokeAsync<PoVoxelStrikeLobbyState>("Join", _displayName, _isGuest);

        _lobby = HubConnectionFactory.Create(_endpoints.Hub("povoxelstrike/lobby-hub"));

        _lobbySubs.Add(_lobby.On<PoVoxelStrikeLobbyState>("lobbyState", s => LobbyUpdated?.Invoke(s)));
        _lobbySubs.Add(_lobby.On<PoVoxelStrikeLobbyEvent>("lobbyEvent", e => LobbyEvent?.Invoke(e)));
        _lobbySubs.Add(_lobby.On<string>("gameStarted", code => GameStarted?.Invoke(code)));

        await _lobby.StartAsync();

        // Re-join on every reconnect — the server ran Leave for the old connection id, so
        // a fresh Join is the only way back into the lobby. The reconnect path is best
        // effort; if it throws, the user's next manual action (toggle ready, leave)
        // surfaces a normal error and they can recover.
        _lobby.Reconnected += async _ =>
        {
            try { await _lobby.InvokeAsync<PoVoxelStrikeLobbyState>("Join", _displayName, _isGuest); } catch { /* surfaced on next user action */ }
        };

        return await _lobby.InvokeAsync<PoVoxelStrikeLobbyState>("Join", _displayName, _isGuest);
    }

    public Task ToggleReadyAsync() => _lobby?.InvokeAsync("ToggleReady") ?? Task.CompletedTask;

    public Task StartGameAsync() => _lobby?.InvokeAsync("StartGame") ?? Task.CompletedTask;

    public Task LeaveLobbyAsync() => _lobby?.InvokeAsync("LeaveLobby") ?? Task.CompletedTask;

    // ── Lockstep ──────────────────────────────────────────────────────────

    /// <summary>
    /// Join (or rejoin) the active run. Returns the session info (players, tick rate) so
    /// the engine can spin up its multiplayer branch with the correct player roster.
    /// </summary>
    public async Task<PoVoxelStrikeLockstepSessionInfo?> JoinLockstepAsync(string gameCode)
    {
        _gameCode = gameCode;
        if (_lockstep is null)
        {
            _lockstep = HubConnectionFactory.Create(_endpoints.Hub("povoxelstrike/lockstep-hub"));

            _lockstepSubs.Add(_lockstep.On<PoVoxelStrikeLockstepFrame>("frame", f => FrameReceived?.Invoke(f)));
            _lockstepSubs.Add(_lockstep.On<string>("playerDropped", c => PlayerDropped?.Invoke(c)));
            _lockstepSubs.Add(_lockstep.On("runEnded", () => RunEnded?.Invoke()));

            await _lockstep.StartAsync();

            _lockstep.Reconnected += async _ =>
            {
                try { await _lockstep.InvokeAsync<PoVoxelStrikeLockstepSessionInfo?>("JoinLockstep", _gameCode); }
                catch { /* surfaced on next user action */ }
            };
        }
        return await _lockstep.InvokeAsync<PoVoxelStrikeLockstepSessionInfo?>("JoinLockstep", _gameCode);
    }

    /// <summary>Ship a batch of local inputs to the server for relay on the next frame.</summary>
    public Task SubmitInputsAsync(PoVoxelStrikeInputBatch batch)
    {
        // Stamp the connection id client-side; the hub overwrites it server-side too.
        batch.ConnectionId = _lockstep?.ConnectionId ?? "";
        return _lockstep?.InvokeAsync("SubmitInputs", batch) ?? Task.CompletedTask;
    }

    /// <summary>Tell the server the last tick we acked + the local fingerprint for desync detection.</summary>
    public Task HeartbeatAsync(PoVoxelStrikeClientHeartbeat heartbeat)
        => _lockstep?.InvokeAsync("Heartbeat", heartbeat) ?? Task.CompletedTask;

    /// <summary>Host-only: end the run and broadcast runEnded to every peer.</summary>
    public Task EndRunAsync() => _lockstep?.InvokeAsync("EndRun") ?? Task.CompletedTask;

    /// <summary>Close the lockstep connection when the run ends. Mirrors PoSports.StopRaceAsync.</summary>
    public async Task StopLockstepAsync()
    {
        var lockstep = _lockstep;
        _lockstep = null;
        _gameCode = "";
        foreach (var s in _lockstepSubs) s.Dispose();
        _lockstepSubs.Clear();
        if (lockstep is not null)
        {
            try { await lockstep.DisposeAsync(); } catch { /* socket may already be closed */ }
        }
    }

    public async ValueTask DisposeAsync()
    {
        await StopLockstepAsync();
        if (_lobby is not null)
        {
            foreach (var s in _lobbySubs) s.Dispose();
            _lobbySubs.Clear();
            try { await _lobby.DisposeAsync(); } catch { /* socket may already be closed */ }
            _lobby = null;
        }
    }
}
