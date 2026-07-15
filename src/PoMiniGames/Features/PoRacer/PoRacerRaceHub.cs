using Microsoft.AspNetCore.SignalR;
using PoShared.Games;

namespace PoMiniGames.Features.PoRacer;

/// <summary>
/// Server-authoritative race hub. Each connection joins a per-race group
/// (<c>poracer-race-{CODE}</c>) and receives a stream of
/// <see cref="PoRacerRaceSnapshot"/>s at ~20 Hz plus a single
/// <see cref="PoRacerFinalResult"/> when the race ends. Clients send
/// <see cref="PoRacerInput"/> packets; the server broadcasts them through the
/// long-lived <see cref="IHubContext{T}"/> so the wiring survives hub
/// disposal (the connection that triggered the wiring can leave; the race
/// still broadcasts to whoever is left).
/// </summary>
public sealed class PoRacerRaceHub : Hub
{
    private readonly PoRacerRaceRegistry _registry;
    private readonly IHubContext<PoRacerRaceHub> _hubContext;
    private readonly ILogger<PoRacerRaceHub> _log;

    public PoRacerRaceHub(PoRacerRaceRegistry registry, IHubContext<PoRacerRaceHub> hubContext, ILogger<PoRacerRaceHub> log)
    {
        _registry = registry;
        _hubContext = hubContext;
        _log = log;
    }

    public override async Task OnDisconnectedAsync(Exception? ex)
    {
        var code = _registry.CodeFor(Context.ConnectionId);
        _registry.RemoveConnection(Context.ConnectionId);
        if (code is not null) await Groups.RemoveFromGroupAsync(Context.ConnectionId, RaceGroup(code));
        await base.OnDisconnectedAsync(ex);
    }

    /// <summary>
    /// Join a race. Idempotent — re-joining re-adds to the group and re-pulls
    /// the static world + latest snapshot so a reconnecting player gets back
    /// in without a lobby round-trip.
    /// </summary>
    public async Task<PoRacerRaceSnapshot?> JoinRace(string code)
    {
        if (string.IsNullOrWhiteSpace(code)) return null;
        var race = await _registry.GetOrCreateAsync(code);
        _registry.RegisterConnection(code, Context.ConnectionId);
        await Groups.AddToGroupAsync(Context.ConnectionId, RaceGroup(code));
        var snap = new PoRacerRaceSnapshot
        {
            GameCode = code,
            ServerTimeMs = 0,
            Cars = Array.Empty<PoRacerCarState>(),
            ElapsedRaceTime = 0,
            CountdownMs = 3000,
            Started = false,
            Finished = false,
            Static = race.GetStaticWorld(),
        };
        await EnsureBroadcastsWiredAsync(race);
        return snap;
    }

    private readonly HashSet<string> _wiredRaces = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _wireLock = new();

    private Task EnsureBroadcastsWiredAsync(PoRacerRaceService race)
    {
        lock (_wireLock)
        {
            if (_wiredRaces.Contains(race.GameCode)) return Task.CompletedTask;
            _wiredRaces.Add(race.GameCode);
        }
        // Use the long-lived IHubContext so broadcasts survive the wiring
        // connection leaving the hub.
        var hub = _hubContext;
        var log = _log;
        race.SnapshotReady += snap =>
        {
            // Fire-and-forget broadcast (~20 Hz). Wrap in a local async helper so a
            // failed SendAsync (e.g. transport tear-down mid-broadcast) is observed
            // and logged instead of surfacing as an unobserved TaskException.
            _ = BroadcastSnapshotAsync(snap);
        };
        race.Finished += result =>
        {
            _ = BroadcastFinishedAsync(result);
            _ = DisposeRaceAfterDelayAsync(result.GameCode);
        };
        return Task.CompletedTask;

        async Task BroadcastSnapshotAsync(PoRacerRaceSnapshot snap)
        {
            try
            {
                await hub.Clients.Group(RaceGroup(snap.GameCode)).SendAsync("raceSnapshot", snap);
            }
            catch (Exception ex)
            {
                log.LogError(ex, "PoRacer: raceSnapshot broadcast failed for {Code}", snap.GameCode);
            }
        }

        async Task BroadcastFinishedAsync(PoRacerFinalResult result)
        {
            try
            {
                await hub.Clients.Group(RaceGroup(result.GameCode)).SendAsync("raceFinished", result);
            }
            catch (Exception ex)
            {
                log.LogError(ex, "PoRacer: raceFinished broadcast failed for {Code}", result.GameCode);
            }
        }

        async Task DisposeRaceAfterDelayAsync(string gameCode)
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(5));
                if (_registry.GetByCode(gameCode) is { } raceToDispose)
                {
                    if (_wiredRaces.Remove(gameCode))
                    {
                        await raceToDispose.DisposeAsync();
                    }
                }
            }
            catch (Exception ex)
            {
                log.LogError(ex, "PoRacer: delayed race dispose failed for {Code}", gameCode);
            }
        }
    }

    public Task SendInput(string code, PoRacerInput input)
    {
        var race = _registry.GetByCode(code);
        if (race is null) return Task.CompletedTask;
        _registry.RegisterConnection(code, Context.ConnectionId);
        race.SetInput(Context.ConnectionId, input);
        return Task.CompletedTask;
    }

    private static string RaceGroup(string code) => "poracer-race-" + code;
}