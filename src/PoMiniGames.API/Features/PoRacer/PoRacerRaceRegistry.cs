using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoRacer;

/// <summary>Owns races, broadcast subscriptions, connection bindings and expiry.</summary>
public sealed class PoRacerRaceRegistry : IAsyncDisposable
{
    private readonly Dictionary<string, PoRacerRaceService> _races = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, string> _connections = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private readonly PoRacerLobbyService _lobby;
    private readonly IHubContext<PoRacerRaceHub> _hub;
    private readonly ILoggerFactory _logs;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly Task _expiry;

    public PoRacerRaceRegistry(PoRacerLobbyService lobby, IHubContext<PoRacerRaceHub> hub, ILoggerFactory logs)
    {
        _lobby = lobby;
        _hub = hub;
        _logs = logs;
        _expiry = ExpireAsync();
    }

    public PoRacerRaceService StartMultiplayer() => GetOrCreate(_lobby.CreateRaceCode(), _lobby.Players.DistinctBy(p => p.UserId).ToArray(), null);

    public PoRacerRaceService Join(string code, bool asPlayer, PoRacerLobbyPlayer player, string? trackId)
    {
        if (code.StartsWith("multi-", StringComparison.Ordinal))
            return GetByCode(code) ?? throw new HubException("The race has ended. Return to the lobby.");
        if (!asPlayer) return GetOrCreate("DEMO", [], trackId);
        if (!code.StartsWith("solo-", StringComparison.Ordinal) || code.Length > 48)
            throw new HubException("Invalid race code.");
        return GetOrCreate(code, [player], trackId);
    }

    private PoRacerRaceService GetOrCreate(string code, IReadOnlyList<PoRacerLobbyPlayer> players, string? trackId)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_shutdown.IsCancellationRequested, this);
            if (_races.TryGetValue(code, out var existing)) return existing;
            if (_races.Count >= 64) throw new HubException("The race grid is busy. Try again shortly.");
            var race = new PoRacerRaceService(code, players, _logs.CreateLogger<PoRacerRaceService>(), trackId);
            race.SnapshotReady += snapshot => BroadcastAsync(code, "raceSnapshot", snapshot);
            race.Finished += result => BroadcastAsync(code, "raceFinished", result);
            _races.Add(code, race);
            race.Start();
            return race;
        }
    }

    private async Task BroadcastAsync<T>(string code, string method, T message)
    {
        try { await _hub.Clients.Group(RaceGroup(code)).SendAsync(method, message, _shutdown.Token); }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested) { }
        catch (Exception ex) { _logs.CreateLogger<PoRacerRaceRegistry>().LogWarning(ex, "Race broadcast failed: {Code}", code); }
    }

    public PoRacerRaceService? GetByCode(string code)
    {
        lock (_gate) return _races.GetValueOrDefault(code);
    }

    public void RegisterConnection(string code, string connectionId)
    {
        lock (_gate)
        {
            if (_connections.TryGetValue(connectionId, out var oldCode) &&
                !string.Equals(oldCode, code, StringComparison.OrdinalIgnoreCase) && _races.TryGetValue(oldCode, out var old))
                old.RemoveConnection(connectionId);
            _connections[connectionId] = code;
            _races[code].AddConnection(connectionId);
        }
    }

    public void RemoveConnection(string connectionId)
    {
        lock (_gate)
            if (_connections.Remove(connectionId, out var code) && _races.TryGetValue(code, out var race))
                race.RemoveConnection(connectionId);
    }

    public string? CodeFor(string connectionId)
    {
        lock (_gate) return _connections.GetValueOrDefault(connectionId);
    }

    public static string RaceGroup(string code) => "poracer-race-" + code.ToUpperInvariant();

    private async Task ExpireAsync()
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        try
        {
            while (await timer.WaitForNextTickAsync(_shutdown.Token))
            {
                List<PoRacerRaceService> expired;
                lock (_gate)
                {
                    expired = _races.Values.Where(r => r.HasExpired(DateTimeOffset.UtcNow)).ToList();
                    foreach (var race in expired)
                    {
                        _races.Remove(race.GameCode);
                        foreach (var connection in _connections.Where(c => string.Equals(c.Value, race.GameCode, StringComparison.OrdinalIgnoreCase)).Select(c => c.Key).ToArray())
                            _connections.Remove(connection);
                        if (race.GameCode == _lobby.GameCode) _lobby.End();
                    }
                }
                foreach (var race in expired) await race.DisposeAsync();
            }
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested) { }
    }

    public async ValueTask DisposeAsync()
    {
        await _shutdown.CancelAsync();
        await _expiry;
        List<PoRacerRaceService> races;
        lock (_gate)
        {
            races = _races.Values.ToList();
            _races.Clear();
            _connections.Clear();
        }
        foreach (var race in races) await race.DisposeAsync();
        _shutdown.Dispose();
    }
}
