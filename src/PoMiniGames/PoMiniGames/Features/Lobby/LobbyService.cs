namespace PoMiniGames.Features.Lobby;

internal sealed class LobbyService : ILobbyService
{
    private readonly object _lock = new();
    private readonly Dictionary<string, LobbyPlayer> _players = new(StringComparer.Ordinal);

    public LobbySnapshot AddPlayer(string userId, string displayName)
    {
        lock (_lock)
        {
            if (!_players.ContainsKey(userId))
            {
                _players[userId] = new LobbyPlayer(userId, displayName, DateTimeOffset.UtcNow);
            }

            return BuildSnapshot();
        }
    }

    public LobbySnapshot RemovePlayer(string userId)
    {
        lock (_lock)
        {
            _players.Remove(userId);
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
        return new LobbySnapshot(players, hostUserId);
    }
}

