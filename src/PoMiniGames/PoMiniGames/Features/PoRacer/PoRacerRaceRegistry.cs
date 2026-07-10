using System.Collections.Concurrent;

namespace PoMiniGames.Features.PoRacer;

/// <summary>
/// Process-local registry of running PoRacer races. In single-lobby mode
/// there is at most one race at a time, but the registry keeps the
/// abstraction in case we ever support multiple rooms again.
/// </summary>
public sealed class PoRacerRaceRegistry : IAsyncDisposable
{
    private readonly PoRacerLobbyService _lobby;
    private readonly ILoggerFactory _loggerFactory;
    private PoRacerRaceService? _currentRace;
    private readonly ConcurrentDictionary<string, string> _connectionToCode = new();
    private readonly object _createLock = new();

    public PoRacerRaceRegistry(PoRacerLobbyService lobby, ILoggerFactory loggerFactory)
    {
        _lobby = lobby;
        _loggerFactory = loggerFactory;
    }

    public async Task<PoRacerRaceService> GetOrCreateAsync(string code)
    {
        lock (_createLock)
        {
            if (_currentRace is { } existing && existing.GameCode == code) return existing;
        }
        var players = _lobby.Players.ToList();
        var log = _loggerFactory.CreateLogger<PoRacerRaceService>();
        var race = new PoRacerRaceService(code, players, _lobby, log);
        lock (_createLock) { _currentRace = race; }
        return race;
    }

    public PoRacerRaceService? GetByCode(string code) =>
        _currentRace is { } r && string.Equals(r.GameCode, code, StringComparison.OrdinalIgnoreCase) ? r : null;

    public void RegisterConnection(string code, string connectionId) => _connectionToCode[connectionId] = code;

    public void RemoveConnection(string connectionId) => _connectionToCode.TryRemove(connectionId, out _);

    public void RemoveInput(string connectionId)
    {
        _currentRace?.RemoveInput(connectionId);
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