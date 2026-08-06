namespace PoMiniGames.Features.PoCoupleQuiz;

// ── Strongly-typed client interface (compile-time-safe SignalR events) ──────

public record GamePlayerState(string Name, bool IsKingPlayer, int Score);

public record LobbyEventPayload(
    string GameCode,
    bool IsHost,
    string PlayerName,
    List<string> Players,
    List<string> ReadyPlayers,
    string HostName,
    string Difficulty,
    string AiMode = "Remote");

public record LobbyUpdatedPayload(
    string GameCode,
    List<string> Players,
    List<string> ReadyPlayers,
    string HostName,
    string? Difficulty = null,
    string? AiMode = null);

public record GameStartedPayload(
    string GameCode,
    string KingPlayerName,
    List<GamePlayerState> Players,
    string QuestionText,
    string QuestionCategory,
    int RoundIndex,
    int MaxRounds,
    string Difficulty,
    string AiMode = "Remote");

public record RoundStartedPayload(
    string GameCode,
    int RoundIndex,
    int MaxRounds,
    string KingPlayerName,
    List<GamePlayerState> Players,
    string QuestionText,
    string QuestionCategory,
    string AiMode = "Remote");

public record AnswerRecordedPayload(string PlayerName, int RoundIndex);

public record RoundResultPayload(
    string GameCode,
    int RoundIndex,
    string KingAnswer,
    List<string> MatchedPlayers,
    Dictionary<string, int> Scores,
    Dictionary<string, string> PlayerAnswers,
    List<GamePlayerState> Players);

public record GameOverPayload(
    string GameCode,
    IReadOnlyDictionary<string, int> FinalScores,
    List<GamePlayerState> Players);

public record HostChangedPayload(string GameCode, string NewHostName);

public interface IGameClient
{
    Task LobbyCreated(LobbyEventPayload payload);
    Task LobbyJoined(LobbyEventPayload payload);
    Task LobbyUpdated(LobbyUpdatedPayload payload);
    Task LobbyError(string message);

    Task GameStarted(GameStartedPayload payload);
    Task RoundStarted(RoundStartedPayload payload);
    Task AnswerRecorded(AnswerRecordedPayload payload);
    Task RoundResult(RoundResultPayload payload);
    Task GameOver(GameOverPayload payload);
    Task GameError(string message);

    Task PlayerDisconnected(LobbyUpdatedPayload payload);
    Task HostChanged(HostChangedPayload payload);
}
