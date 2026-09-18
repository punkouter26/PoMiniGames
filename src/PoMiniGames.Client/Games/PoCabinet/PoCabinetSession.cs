using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Services.Http;

namespace PoMiniGamesClient.Games.PoCabinet;

/// <summary>
/// Owns one PoCabinet race connection. The lifecycle is:
/// <list type="number">
///   <item>Connect to the lobby hub (<c>/pocabinet/lobby-hub</c>) and call
///         <c>Open</c> with the chosen track — server returns an 8-char join
///         code (<see cref="JoinCode"/>).</item>
///   <item>Player 2 joins by code, marks ready; host calls <c>TryStart</c> —
///         server emits <see cref="RaceStarting"/> with the agreed track id.
///         The client uses a stripped lobby shape (<see cref="LobbyState"/>) to
///         stay free of a cross-project reference to the API's internal types.</item>
///   <item>On start, the client connects to the race hub
///         (<c>/pocabinet/race-hub</c>), calls <c>JoinRace</c> with the code,
///         and starts receiving 30 Hz <see cref="PoCabinetRaceSnapshot"/>s.</item>
///   <item>Per-tick <see cref="PoCabinetInput"/>s stream via <c>SubmitInput</c>.
///         Inputs are coalesced locally — a tight player stream does not
///         flood the hub — and replayed on reconnect.</item>
/// </list>
/// <para>
/// Automatic reconnect is configured by <see cref="HubConnectionFactory"/>;
/// on reconnect we rejoin the race and replay the last-known input so the
/// race continues to look responsive while the network heals.
/// </para>
/// </summary>
public sealed class PoCabinetSession : IAsyncDisposable
{
    private readonly HubConnection _lobby;
    private readonly HubConnection _race;
    private readonly CancellationTokenSource _lifetime = new();
    private PoCabinetInput _lastInput = new();
    private string? _gameCode;
    private bool _raceJoined;

    /// <summary>Wire-shape for the lobby view. Mirrors the API's Lobby but lives
    /// here to avoid coupling this client project to the API's internal types.
    /// </summary>
    public sealed record LobbyPlayerInfo(string ConnectionId, string DisplayName, bool IsGuest, bool IsReady);
    public sealed record LobbyState(string Code, string HostConnectionId, string HostDisplayName, string TrackId, bool IsStarted, IReadOnlyList<LobbyPlayerInfo> Players);

    public PoCabinetSession(ApiEndpoints endpoints)
    {
        _lobby = HubConnectionFactory.Create(endpoints.Hub("pocabinet/lobby-hub"));
        _race = HubConnectionFactory.Create(endpoints.Hub("pocabinet/race-hub"));

        _lobby.On<string>("PlayerJoined", _ => { /* rack for future joined-count UI */ });
        _lobby.On<string, object>("RaceStarting", async (trackId, _) =>
        {
            if (RaceStarting is { } handler) await handler(trackId);
        });
        _race.On<PoCabinetRaceSnapshot>("RaceSnapshot", async snapshot =>
        {
            if (SnapshotReceived is { } handler) await handler(snapshot);
        });
        _race.On<string>("RaceFinished", async code =>
        {
            if (RaceFinished is { } handler) await handler(code);
        });
        _race.Reconnecting += async _ =>
        {
            if (StatusChanged is { } handler) await handler("Reconnecting…");
        };
        _race.Reconnected += async _ =>
        {
            try
            {
                if (_gameCode is not null)
                {
                    await _race.InvokeAsync("JoinRace", _gameCode);
                    await SendInputAsync(_lastInput);
                }
                if (StatusChanged is { } handler) await handler(null);
            }
            catch
            {
                if (StatusChanged is { } handler) await handler("Could not rejoin the race.");
            }
        };
    }

    /// <summary>The 8-char code returned by the server when the host opened the lobby.</summary>
    public string? JoinCode { get; private set; }

    /// <summary>Invoked on every race snapshot from the server.</summary>
    public event Func<PoCabinetRaceSnapshot, Task>? SnapshotReceived;

    /// <summary>Invoked when the server hands off from the lobby hub to the race hub.</summary>
    public event Func<string, Task>? RaceStarting;

    /// <summary>Invoked when the race ends (winner crossed the line + grace).</summary>
    public event Func<string, Task>? RaceFinished;

    /// <summary>Invoked with a non-null message when the connection is unhealthy, null when restored.</summary>
    public event Func<string?, Task>? StatusChanged;

    /// <summary>Invoked with the measured round-trip time in milliseconds after each ping probe.</summary>
    public event Func<double, Task>? PingMeasured;

    private Task _pingLoop = Task.CompletedTask;

    /// <summary>Open a new lobby on the lobby hub. Returns the 8-char join code.</summary>
    public async Task<string> OpenLobbyAsync(string displayName, bool isGuest, string? trackId, CancellationToken cancellationToken = default)
    {
        if (_lobby.State != HubConnectionState.Connected)
            await _lobby.StartAsync(cancellationToken);
        JoinCode = await _lobby.InvokeAsync<string>("Open", displayName, isGuest, trackId, cancellationToken);
        return JoinCode;
    }

    /// <summary>True if the server placed the player into the lobby (false = unknown code, full, or started).</summary>
    public async Task<bool> JoinLobbyAsync(string joinCode, string displayName, bool isGuest, CancellationToken cancellationToken = default)
    {
        if (_lobby.State != HubConnectionState.Connected)
            await _lobby.StartAsync(cancellationToken);
        // The hub returns the API's internal Lobby type — we only need to know
        // it succeeded, so we collapse it via a discarded object.
        var joined = await _lobby.InvokeAsync<object?>("Join", joinCode, displayName, isGuest, cancellationToken);
        return joined is not null;
    }

    public async Task ToggleReadyAsync(string joinCode, CancellationToken cancellationToken = default)
    {
        await _lobby.InvokeAsync<bool>("ToggleReady", joinCode, cancellationToken);
    }

    public async Task<bool> TryStartAsync(string joinCode, CancellationToken cancellationToken = default)
    {
        return await _lobby.InvokeAsync<bool>("TryStart", joinCode, cancellationToken);
    }

    /// <summary>Open the race hub and subscribe to the game. Returns the initial snapshot.</summary>
    public async Task<PoCabinetRaceSnapshot> JoinRaceAsync(string gameCode, CancellationToken cancellationToken = default)
    {
        _gameCode = gameCode;
        if (_race.State != HubConnectionState.Connected)
            await _race.StartAsync(cancellationToken);
        var snapshot = await _race.InvokeAsync<PoCabinetRaceSnapshot>("JoinRace", gameCode, cancellationToken);
        _raceJoined = true;
        return snapshot;
    }

    /// <summary>
    /// Begin the latency probe loop (idempotent). Every 3 seconds the hub's
    /// <c>Ping</c> method is invoked and the round-trip time raised on
    /// <see cref="PingMeasured"/>; the HUD's ping badge consumes it. Failures
    /// are swallowed — a probe failing is exactly what a bad connection looks
    /// like, and <see cref="StatusChanged"/> already covers that story.
    /// </summary>
    public void StartPingLoop()
    {
        if (_pingLoop.IsCompleted) _pingLoop = PingLoopAsync(_lifetime.Token);
    }

    private async Task PingLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(3000, ct);
                if (_raceJoined && _gameCode is not null && _race.State == HubConnectionState.Connected)
                {
                    var sw = System.Diagnostics.Stopwatch.StartNew();
                    await _race.InvokeAsync("Ping", _gameCode, ct);
                    sw.Stop();
                    if (PingMeasured is { } handler)
                        await handler(sw.Elapsed.TotalMilliseconds);
                }
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch
            {
                // Probe failed — skip this beat; the loop retries on the next tick.
            }
        }
    }

    /// <summary>
    /// Coalesced input send. The race server reads the dictionary on every
    /// tick; if the connection is mid-reconnect we just remember the last
    /// input and replay it on Reconnected.
    /// </summary>
    public Task SendInputAsync(PoCabinetInput input)
    {
        _lastInput = input;
        if (!_raceJoined || _gameCode is null) return Task.CompletedTask;
        return _race.InvokeAsync("SubmitInput", _gameCode, input);
    }

    public async ValueTask DisposeAsync()
    {
        _lifetime.Cancel();
        try { await _lobby.DisposeAsync(); } catch { /* ignore */ }
        try { await _race.DisposeAsync(); } catch { /* ignore */ }
        _lifetime.Dispose();
    }
}
