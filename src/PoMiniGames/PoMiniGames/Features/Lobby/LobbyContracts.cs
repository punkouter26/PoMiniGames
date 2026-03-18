namespace PoMiniGames.Features.Lobby;

public sealed record LobbyPlayer(string UserId, string DisplayName, DateTimeOffset JoinedAt);

public sealed record LobbySnapshot(LobbyPlayer[] Players, string? HostUserId, bool IsStarting = false, string? StartingGameKey = null);

public sealed record LobbyStartRequest(string GameKey);

public interface ILobbyService
{
    LobbySnapshot AddPlayer(string userId, string displayName);

    LobbySnapshot RemovePlayer(string userId);

    LobbySnapshot GetSnapshot();

    bool IsHost(string userId);

    /// <summary>Marks the lobby as having started a game so late joiners are redirected.</summary>
    void SetStarting(string gameKey);

    bool IsStarting { get; }

    string? StartingGameKey { get; }
}

