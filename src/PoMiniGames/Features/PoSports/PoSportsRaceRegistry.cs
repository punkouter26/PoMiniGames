using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Application.Services;

namespace PoMiniGames.Features.PoSports;

/// <summary>
/// Process-local registry of running PoSports meets, mirroring
/// <see cref="PoRacer.PoRacerRaceRegistry"/>: single-lobby mode means at most one
/// meet at a time, but the abstraction stays in case multiple rooms return.
/// Snapshot/finish broadcasts are wired HERE (singleton) rather than in the hub —
/// hubs are transient per invocation, so hub-side wiring re-subscribes on every
/// join and duplicates broadcasts.
/// </summary>
public sealed class PoSportsRaceRegistry : IAsyncDisposable
{
    private readonly PoSportsLobbyService _lobby;
    private readonly IStorageService _storage;
    private readonly IHubContext<PoSportsRaceHub> _hub;
    private readonly ILoggerFactory _loggerFactory;
    private readonly ILogger<PoSportsRaceRegistry> _log;
    private PoSportsRaceService? _currentRace;
    private readonly ConcurrentDictionary<string, string> _connectionToCode = new();
    private readonly object _createLock = new();

    public PoSportsRaceRegistry(
        PoSportsLobbyService lobby,
        IStorageService storage,
        IHubContext<PoSportsRaceHub> hub,
        ILoggerFactory loggerFactory)
    {
        _lobby = lobby;
        _storage = storage;
        _hub = hub;
        _loggerFactory = loggerFactory;
        _log = loggerFactory.CreateLogger<PoSportsRaceRegistry>();
    }

    internal static string RaceGroup(string code) => "posports-race-" + code;

    /// <summary>
    /// Codes are compared and grouped case-insensitively, so <c>/posports/race/lobby</c>
    /// and <c>.../LOBBY</c> address the same meet instead of the lowercase spelling
    /// displacing the running race and stranding its group.
    /// </summary>
    internal static string NormalizeCode(string code) => code.Trim().ToUpperInvariant();

    /// <summary>
    /// Get the meet for <paramref name="code"/>, creating one seeded from the lobby when
    /// the host has actually started a meet. Returns null when there is nothing to join —
    /// callers must treat that as "no race", not as a reason to spin one up.
    /// </summary>
    /// <remarks>
    /// Two rules keep the single-slot registry honest:
    /// a FINISHED race is never handed out (its podium phase is terminal, so a rematch
    /// inside the 30 s grace window would pin everyone to the previous meet's results),
    /// and a race is only created while <see cref="PoSportsLobbyService.RaceStarted"/> is
    /// set (otherwise any authenticated client could conjure a ghost meet by browsing to
    /// the race URL — which also called EndRace on the real lobby when it finished).
    /// Whenever a race IS displaced, it is disposed here: the delayed sweep skips
    /// non-current races, so nothing else would ever stop its timers.
    /// </remarks>
    public PoSportsRaceService? TryGetOrCreate(string code)
    {
        code = NormalizeCode(code);
        lock (_createLock)
        {
            if (Reusable(code) is { } existing) return existing;
            if (!_lobby.RaceStarted) return null;
        }
        var seats = _lobby.Seats;
        if (seats.Count == 0) return null;
        var race = new PoSportsRaceService(
            code, seats, _lobby, _storage, _loggerFactory.CreateLogger<PoSportsRaceService>());
        PoSportsRaceService? displaced;
        lock (_createLock)
        {
            // A concurrent creator may have won — prefer theirs, drop ours unwired.
            if (Reusable(code) is { } winner)
            {
                _ = race.DisposeAsync();
                return winner;
            }
            displaced = _currentRace;
            _currentRace = race;
        }
        if (displaced is not null)
        {
            _log.LogInformation("PoSports: replacing race {Old} with {New}", displaced.GameCode, race.GameCode);
            _ = displaced.DisposeAsync();
        }
        Wire(race);
        return race;
    }

    /// <summary>The current race when it can still be joined. Callers hold <see cref="_createLock"/>.</summary>
    private PoSportsRaceService? Reusable(string code) =>
        _currentRace is { } r
        && !r.IsFinished
        && string.Equals(r.GameCode, code, StringComparison.OrdinalIgnoreCase)
            ? r
            : null;

    private void Wire(PoSportsRaceService race)
    {
        race.SnapshotReady += snap => _ = BroadcastAsync("raceSnapshot", race.GameCode, snap);
        race.Finished += final =>
        {
            _ = BroadcastAsync("raceFinished", race.GameCode, final);
            _ = DisposeAfterDelayAsync(race);
        };
    }

    private async Task BroadcastAsync(string method, string code, object payload)
    {
        try
        {
            await _hub.Clients.Group(RaceGroup(code)).SendAsync(method, payload);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "PoSports: {Method} broadcast failed for {Code}", method, code);
        }
    }

    private async Task DisposeAfterDelayAsync(PoSportsRaceService race)
    {
        try
        {
            // Grace window so late "raceFinished" pulls and podium screens can settle.
            await Task.Delay(TimeSpan.FromSeconds(30));
            lock (_createLock)
            {
                // Only clear the slot if this race still owns it — a rematch may already
                // have replaced (and disposed) it. Dispose unconditionally either way:
                // returning early here is what leaked displaced races' timers forever.
                if (ReferenceEquals(_currentRace, race)) _currentRace = null;
            }
            await race.DisposeAsync();
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "PoSports: delayed race dispose failed for {Code}", race.GameCode);
        }
    }

    public PoSportsRaceService? GetByCode(string code) =>
        _currentRace is { } r && string.Equals(r.GameCode, NormalizeCode(code), StringComparison.OrdinalIgnoreCase) ? r : null;

    public void RegisterConnection(string code, string connectionId) =>
        _connectionToCode[connectionId] = NormalizeCode(code);

    public void RemoveConnection(string connectionId)
    {
        _connectionToCode.TryRemove(connectionId, out _);
        _currentRace?.RemoveConnection(connectionId);
    }

    public string? CodeFor(string connectionId) =>
        _connectionToCode.TryGetValue(connectionId, out var c) ? c : null;

    public async ValueTask DisposeAsync()
    {
        if (_currentRace is not null) await _currentRace.DisposeAsync();
        _currentRace = null;
        _connectionToCode.Clear();
    }
}
