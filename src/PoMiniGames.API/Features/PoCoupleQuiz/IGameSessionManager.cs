namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// The one in-memory lobby. State does NOT survive restarts.
/// </summary>
/// <remarks>
/// Every method used to take a <c>gameCode</c>. Codes are gone (2026-08-10): the manager only
/// ever served one lobby in practice — <c>JoinOrCreateLobby</c> auto-joined the first waiting
/// session and the client's "join by code" box existed to reach a lobby the same call would
/// have found anyway. One session means no code generation, no per-call lookup that can miss,
/// and no "the code may be invalid" failure mode.
/// </remarks>
public interface IGameSessionManager
{
    /// <summary>The current lobby, or null when nobody is in one.</summary>
    GameSession? Current { get; }

    /// <summary>Join the lobby, creating it if this is the first player. Never fails.</summary>
    GameSession Join(string connectionId, string playerName, out bool created);

    /// <summary>Drop a player. Returns the session (null if the caller wasn't in one).</summary>
    GameSession? RemovePlayer(string connectionId, out bool sessionEmpty);

    GameSession? GetSessionByConnection(string connectionId);

    /// <summary>Begin a match with the given first question. Throws if there is no lobby.</summary>
    Game StartGame(string questionText, string category);

    bool RecordAnswer(string playerName, string answer);

    Game AdvanceRound();

    void ApplyRoundScores(Dictionary<string, int> pointsEarned);

    void FinishGame();

    LobbyReadyState? MarkPlayerReady(string connectionId);

    LobbyReadyState? GetLobbyReadyState();

    /// <summary>Host-only. Sets how many rounds the next match runs for (3, 5 or 7).</summary>
    LobbyReadyState? SetMaxRounds(string connectionId, int rounds);

    /// <summary>Return a finished lobby to the waiting state so the same players can go again.</summary>
    LobbyReadyState? ResetToLobby();
}
