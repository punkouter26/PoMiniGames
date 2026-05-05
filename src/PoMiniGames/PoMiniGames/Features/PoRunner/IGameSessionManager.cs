namespace PoMiniGames.Features.PoRunner;

public interface IGameSessionManager
{
    GameRoom? GetRoomForPlayer(string connectionId);
    (GameRoom Room, bool IsNewRoom) AddPlayer(string connectionId);
    GameRoom? RemovePlayer(string connectionId);
    void UpdatePlayerState(string connectionId, ClientState clientState);
    bool SetPlayerReady(string connectionId);
    void FinishRace(string connectionId);
    bool AllPlayersReady(string roomId);
    void StartCountdown(string roomId);
    bool RequestRestart(string connectionId);
    void ResetAllSessions();
}
