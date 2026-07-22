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
    /// Get the current meet for <paramref name="code"/>, or create one seeded with the
    /// lobby's current members (called at StartGame/JoinRace time, while the member
    /// list is hot). Creation wires the broadcast pipeline exactly once per race.
    /// </summary>
    public PoSportsRaceService GetOrCreate(string code)
    {
        lock (_createLock)
        {
            if (_currentRace is { } existing && existing.GameCode == code) return existing;
        }
        var members = _lobby.Members.ToList();
        var race = new PoSportsRaceService(
            code, members, _lobby, _storage, _loggerFactory.CreateLogger<PoSportsRaceService>());
        lock (_createLock)
        {
            // A concurrent creator may have won — prefer theirs, drop ours unwired.
            if (_currentRace is { } winner && winner.GameCode == code)
            {
                _ = race.DisposeAsync();
                return winner;
            }
            _currentRace = race;
        }
        Wire(race);
        return race;
    }

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
                if (!ReferenceEquals(_currentRace, race)) return;
                _currentRace = null;
            }
            await race.DisposeAsync();
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "PoSports: delayed race dispose failed for {Code}", race.GameCode);
        }
    }

    public PoSportsRaceService? GetByCode(string code) =>
        _currentRace is { } r && string.Equals(r.GameCode, code, StringComparison.OrdinalIgnoreCase) ? r : null;

    public void RegisterConnection(string code, string connectionId) => _connectionToCode[connectionId] = code;

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
