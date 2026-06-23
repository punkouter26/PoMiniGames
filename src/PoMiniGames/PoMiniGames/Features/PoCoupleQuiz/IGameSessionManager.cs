namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// In-memory lobby / game-session state. Sessions do NOT survive restarts.
/// Singleton (one process-wide state table) + IHostedService so the manager
/// can host background timers (round timers, host-promote grace periods, etc.).
/// </summary>
public interface IGameSessionManager
{
    GameSession CreateLobby(string hostConnectionId, string hostName, DifficultyLevel difficulty, string aiMode = "Remote");
    GameSession? JoinLobby(string gameCode, string connectionId, string playerName);
    GameSession? RemovePlayer(string connectionId, out bool sessionEmpty);
    GameSession? GetSessionByConnection(string connectionId);
    GameSession? GetSession(string gameCode);
    bool LobbyExists(string gameCode);
    Game StartGame(string gameCode, string questionText, string category);
    bool RecordAnswer(string gameCode, string playerName, string answer);
    Game AdvanceRound(string gameCode);
    void ApplyRoundScores(string gameCode, Dictionary<string, int> pointsEarned);
    void FinishGame(string gameCode);
    string? PromoteNextHost(string gameCode);
    GameSession? GetWaitingLobby();
    LobbyReadyState? MarkPlayerReady(string gameCode, string connectionId);
    LobbyReadyState? GetLobbyReadyState(string gameCode);
    LobbyReadyState? UpdateLobbyAiMode(string gameCode, string connectionId, string aiMode);
    LobbyReadyState? ResetReadyState(string gameCode);
    GameSession JoinOrCreateLobby(string connectionId, string playerName, DifficultyLevel difficulty, out bool created, string aiMode = "Remote");
}
