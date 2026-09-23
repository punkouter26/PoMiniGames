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

    /// <summary>
    /// A lobby start (a full roster) ALWAYS creates a fresh match; a join (empty roster) only
    /// ever finds the running one, or null when there is none.
    /// </summary>
    /// <remarks>
    /// 2026-09-23: a start used to return any running match with the same code, and every
    /// lobby uses the one global code. So a pair who started within 60 s of an abandoned fight
    /// were handed the GHOST: their principals were not on its roster, nothing pinned them to a
    /// side, every input was refused, and they watched it time out as a draw. And a join with
    /// no match running constructed one from the empty roster, which throws on Roster[0].
    /// </remarks>
    public async Task<PoBrawlMatchService?> GetOrCreateAsync(string code, IReadOnlyList<PoBrawlLobbyPlayer> roster)
    {
        var log = _loggerFactory.CreateLogger<PoBrawlMatchRegistry>();
        log.LogInformation("GetOrCreateAsync code={Code} rosterSize={Size} current={Current}", code, roster.Count, _currentMatch?.MatchId ?? "null");
        if (roster.Count < 2)
        {
            lock (_createLock)
            {
                return _currentMatch is { } existing && existing.GameCode == code ? existing : null;
            }
        }
        var matchId = Guid.NewGuid().ToString("N");
        var match = new PoBrawlMatchService(matchId, code, roster);
        // Side pinning happens lazily inside the match hub (JoinMatch), keyed by
        // the player principal, not the lobby connection id — the match hub
        // and lobby hub have separate connection-id spaces, so re-pinning here
        // with the lobby conn id would never be useful.
        lock (_createLock) { _currentMatch = match; }
        _connectionToMatchId.Clear();
        // Reset lobby ready flags + end-match state so the next fight needs a fresh Ready round.
        _lobby.End();
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
