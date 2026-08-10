namespace PoMiniGames.Features.PoCoupleQuiz;

// ── Strongly-typed client interface (compile-time-safe SignalR events) ──────
//
// 2026-08-10 simplification: every payload used to carry a GameCode and an
// AiMode. Both are gone. There is exactly ONE lobby in the process, so a code
// identifies nothing; and "AI mode" was a string that only ever held "Remote"
// (no browser-side engine was ever implemented) while being threaded through
// six payloads, three hub methods and the lobby UI. `Difficulty` went the same
// way — it only ever selected the round count, so the lobby now says what it
// means and sends `MaxRounds`.

public record GamePlayerState(string Name, bool IsKingPlayer, int Score);

public record LobbyEventPayload(
    bool IsHost,
    string PlayerName,
    List<string> Players,
    List<string> ReadyPlayers,
    string HostName,
    int MaxRounds);

public record LobbyUpdatedPayload(
    List<string> Players,
    List<string> ReadyPlayers,
    string HostName,
    int MaxRounds);

public record GameStartedPayload(
    string KingPlayerName,
    List<GamePlayerState> Players,
    string QuestionText,
    string QuestionCategory,
    int RoundIndex,
    int MaxRounds,
    int RoundSeconds);

public record RoundStartedPayload(
    int RoundIndex,
    int MaxRounds,
    string KingPlayerName,
    List<GamePlayerState> Players,
    string QuestionText,
    string QuestionCategory,
    int RoundSeconds);

public record AnswerRecordedPayload(string PlayerName, int RoundIndex);

public record RoundResultPayload(
    int RoundIndex,
    string KingAnswer,
    List<string> MatchedPlayers,
    Dictionary<string, int> Scores,
    Dictionary<string, string> PlayerAnswers,
    List<GamePlayerState> Players);

public record GameOverPayload(
    IReadOnlyDictionary<string, int> FinalScores,
    List<GamePlayerState> Players);

public interface IGameClient
{
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
}
