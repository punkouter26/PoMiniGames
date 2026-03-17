namespace PoMiniGames.Features.Lobby;

public sealed record LobbyPlayer(string UserId, string DisplayName, DateTimeOffset JoinedAt);

public sealed record LobbySnapshot(LobbyPlayer[] Players, string? HostUserId);

public sealed record LobbyStartRequest(string GameKey);

public interface ILobbyService
{
    LobbySnapshot AddPlayer(string userId, string displayName);

    LobbySnapshot RemovePlayer(string userId);

    LobbySnapshot GetSnapshot();

    bool IsHost(string userId);
}

