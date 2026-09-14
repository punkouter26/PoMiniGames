using System.Collections.Concurrent;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// Process-local registry of running PoBrawl 1v1 matches. Single-lobby mode
/// means at most one match at a time, but the registry keeps the abstraction
/// in case rooms come back.
/// </summary>
public sealed class PoBrawlMatchRegistry : IAsyncDisposable
{
    private readonly PoBrawlLobbyService _lobby;
    private readonly ILoggerFactory _loggerFactory;
    private PoBrawlMatchService? _currentMatch;
    private readonly ConcurrentDictionary<string, string> _connectionToMatchId = new();
    private readonly object _createLock = new();

    public PoBrawlMatchRegistry(PoBrawlLobbyService lobby, ILoggerFactory loggerFactory)
    {
        _lobby = lobby;
        _loggerFactory = loggerFactory;
    }

    public async Task<PoBrawlMatchService> GetOrCreateAsync(string code, IReadOnlyList<PoBrawlLobbyPlayer> roster)
    {
        lock (_createLock)
        {
            if (_currentMatch is { } existing && existing.GameCode == code) return existing;
        }
        var log = _loggerFactory.CreateLogger<PoBrawlMatchService>();
        var matchId = Guid.NewGuid().ToString("N");
        var match = new PoBrawlMatchService(matchId, code, roster);
        // Pin each lobby player to their side on the match service. The host is
        // always P1, the challenger always P2 (matches the lobby's roster order).
        for (var i = 0; i < roster.Count; i++)
        {
            var side = i == 0 ? PoBrawlSide.Player1 : PoBrawlSide.Player2;
            match.RegisterConnection(roster[i].ConnectionId, side);
            RegisterConnection(matchId, roster[i].ConnectionId);
        }
        lock (_createLock) { _currentMatch = match; }
        // Reset lobby ready flags + end-match state so the next fight needs a fresh Ready round.
        _lobby.EndMatch();
        return await Task.FromResult(match);
    }

    public PoBrawlMatchService? GetByMatchId(string matchId) =>
        _currentMatch is { } m && string.Equals(m.MatchId, matchId, StringComparison.OrdinalIgnoreCase) ? m : null;

    /// <summary>The currently running match, or null. The pump reads this every tick.</summary>
    public PoBrawlMatchService? Current
    {
        get { lock (_createLock) return _currentMatch; }
    }

    public void RegisterConnection(string matchId, string connectionId) => _connectionToMatchId[connectionId] = matchId;

    public void UnregisterConnection(string connectionId) => _connectionToMatchId.TryRemove(connectionId, out _);

    public string? MatchIdFor(string connectionId) =>
        _connectionToMatchId.TryGetValue(connectionId, out var m) ? m : null;

    public void ClearCurrent()
    {
        lock (_createLock)
        {
            _currentMatch = null;
        }
        _connectionToMatchId.Clear();
    }

    public async ValueTask DisposeAsync()
    {
        if (_currentMatch is not null) await _currentMatch.DisposeAsync();
        _currentMatch = null;
        _connectionToMatchId.Clear();
    }
}
