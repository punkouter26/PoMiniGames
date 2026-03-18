namespace PoMiniGames.Features.Lobby;

internal sealed class LobbyService : ILobbyService
{
    private readonly object _lock = new();
    private readonly Dictionary<string, LobbyPlayer> _players = new(StringComparer.Ordinal);
    // Tracks original join times so host priority is preserved across disconnects/reconnects.
    private readonly Dictionary<string, DateTimeOffset> _joinTimes = new(StringComparer.Ordinal);

    // #3: TTL-based eviction for _joinTimes to prevent unbounded memory growth.
    private DateTimeOffset _lastJoinCleanup = DateTimeOffset.MinValue;
    private static readonly TimeSpan JoinCleanupInterval = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan JoinTimeRetention = TimeSpan.FromMinutes(30);

    // #10: StartGame state — prevents race window where late joiners see a phantom lobby.
    private string? _startingGameKey;
    private DateTimeOffset? _startedAt;
    private static readonly TimeSpan StartingStateTtl = TimeSpan.FromSeconds(30);

    public bool IsStarting { get { lock (_lock) { return IsStartingInternal(); } } }

    public string? StartingGameKey { get { lock (_lock) { return IsStartingInternal() ? _startingGameKey : null; } } }

    public void SetStarting(string gameKey)
    {
        lock (_lock)
        {
            _startingGameKey = gameKey;
            _startedAt = DateTimeOffset.UtcNow;
        }
    }

    private bool IsStartingInternal() =>
        _startingGameKey is not null && _startedAt.HasValue
        && DateTimeOffset.UtcNow - _startedAt.Value < StartingStateTtl;

    private void CleanupStaleJoinTimes()
    {
        var now = DateTimeOffset.UtcNow;
        if (now - _lastJoinCleanup < JoinCleanupInterval) return;
        _lastJoinCleanup = now;
        var cutoff = now - JoinTimeRetention;
        foreach (var key in _joinTimes.Keys.ToList())
        {
            if (!_players.ContainsKey(key) && _joinTimes[key] < cutoff)
                _joinTimes.Remove(key);
        }
    }

    public LobbySnapshot AddPlayer(string userId, string displayName)
    {
        lock (_lock)
        {
            CleanupStaleJoinTimes();

            if (!_joinTimes.ContainsKey(userId))
                _joinTimes[userId] = DateTimeOffset.UtcNow;

            _players[userId] = new LobbyPlayer(userId, displayName, _joinTimes[userId]);

            return BuildSnapshot();
        }
    }

    public LobbySnapshot RemovePlayer(string userId)
    {
        lock (_lock)
        {
            CleanupStaleJoinTimes();
            _players.Remove(userId);
            // Reset "starting" state when the lobby becomes empty so the next session starts fresh.
            if (_players.Count == 0)
            {
                _startingGameKey = null;
                _startedAt = null;
            }
            return BuildSnapshot();
        }
    }

    public LobbySnapshot GetSnapshot()
    {
        lock (_lock)
        {
            return BuildSnapshot();
        }
    }

    public bool IsHost(string userId)
    {
        lock (_lock)
        {
            var host = _players.Values
                .OrderBy(p => p.JoinedAt)
                .FirstOrDefault();

            return host is not null && string.Equals(host.UserId, userId, StringComparison.Ordinal);
        }
    }

    private LobbySnapshot BuildSnapshot()
    {
        var players = _players.Values.OrderBy(p => p.JoinedAt).ToArray();
        var hostUserId = players.FirstOrDefault()?.UserId;
        return new LobbySnapshot(players, hostUserId, IsStartingInternal(), IsStartingInternal() ? _startingGameKey : null);
    }
}

