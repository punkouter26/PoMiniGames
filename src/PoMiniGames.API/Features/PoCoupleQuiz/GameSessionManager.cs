using System.Collections.Concurrent;

namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// In-memory implementation of <see cref="IGameSessionManager"/>. Uses
/// <see cref="ConcurrentDictionary{TKey,TValue}"/> for the session table and
/// a separate connection-to-game-code map so the SignalR hub can look up a
/// session by connection id on disconnect.
/// </summary>
/// <remarks>
/// Pattern: Singleton + Active-Record. Each <see cref="GameSession"/> is mutated
/// in place; the manager is the only writer. Lock-free reads from SignalR hub
/// methods are safe because each operation is either <c>GetOrAdd</c> (atomic)
/// or a <c>TryGetValue</c> + <c>Update</c> via <see cref="ConcurrentDictionary{TKey,TValue}"/>.
/// </remarks>
public sealed class GameSessionManager : IGameSessionManager
{
    private const int MinPlayersToStart = 2;
    private const int GameCodeLength = 5;

    private readonly ConcurrentDictionary<string, GameSession> _sessions = new();
    private readonly ConcurrentDictionary<string, string> _connectionToGameCode = new();

    public GameSession CreateLobby(string hostConnectionId, string hostName, DifficultyLevel difficulty, string aiMode = "Remote")
    {
        var code = GenerateUniqueGameCode();
        var session = new GameSession
        {
            GameCode = code,
            HostConnectionId = hostConnectionId,
            Difficulty = difficulty,
            AiMode = aiMode,
            State = SessionState.Waiting,
            Players = new List<LobbyPlayer>
            {
                new(hostName, hostConnectionId)
            }
        };
        _sessions[code] = session;
        _connectionToGameCode[hostConnectionId] = code;
        return session;
    }

    public GameSession? JoinLobby(string gameCode, string connectionId, string playerName)
    {
        if (!_sessions.TryGetValue(gameCode, out var session)) return null;
        if (session.State != SessionState.Waiting) return null;

        // Disconnect an existing entry for this connection id (e.g. reconnect).
        _connectionToGameCode.TryRemove(connectionId, out _);

        // Two anonymous players share one "Guest######" identity when they sign in
        // from the same browser (shared session cookie), so the same name can join
        // twice. The name is the identity key for round scoring, so a collision
        // collapses both players into one. Disambiguate with a numeric suffix.
        var uniqueName = EnsureUniqueName(session, playerName);
        session.Players.Add(new LobbyPlayer(uniqueName, connectionId));
        _connectionToGameCode[connectionId] = gameCode;
        return session;
    }

    public GameSession? RemovePlayer(string connectionId, out bool sessionEmpty)
    {
        sessionEmpty = false;
        if (!_connectionToGameCode.TryRemove(connectionId, out var code)) return null;
        if (!_sessions.TryGetValue(code, out var session)) return null;

        session.Players.RemoveAll(p => p.ConnectionId == connectionId);
        session.ReadyConnectionIds.Remove(connectionId);

        if (session.Players.Count == 0)
        {
            _sessions.TryRemove(code, out _);
            sessionEmpty = true;
            return session;
        }

        // If the host left, promote the next player.
        if (session.HostConnectionId == connectionId)
        {
            session.HostConnectionId = session.Players[0].ConnectionId;
        }

        return session;
    }

    public GameSession? GetSessionByConnection(string connectionId) =>
        _connectionToGameCode.TryGetValue(connectionId, out var code) && _sessions.TryGetValue(code, out var s) ? s : null;

    public GameSession? GetSession(string gameCode) =>
        _sessions.TryGetValue(gameCode, out var s) ? s : null;

    public bool LobbyExists(string gameCode) => _sessions.ContainsKey(gameCode);

    public Game StartGame(string gameCode, string questionText, string category)
    {
        if (!_sessions.TryGetValue(gameCode, out var session))
        {
            throw new InvalidOperationException($"Game session '{gameCode}' not found.");
        }

        var kingIndex = 0; // The first player to join stays King for the whole game.
        var game = new Game
        {
            Difficulty = session.Difficulty,
            CurrentKingPlayerIndex = kingIndex
        };
        foreach (var p in session.Players)
        {
            game.AddPlayer(new Player
            {
                Name = p.Name,
                IsKingPlayer = p.ConnectionId == session.Players[kingIndex].ConnectionId
            });
        }

        var firstQuestion = new GameQuestion
        {
            Text = questionText,
            Category = Enum.TryParse<QuestionCategory>(category, out var cat) ? cat : QuestionCategory.Preferences
        };
        game.Questions.Add(firstQuestion);
        game.CurrentRound = 0;

        session.ActiveGame = game;
        session.CurrentQuestion = firstQuestion;
        session.State = SessionState.InProgress;
        session.LastEvaluatedRound = -1;
        session.LastAdvancedFromRound = -1;
        session.RoundAnswers.Clear();
        session.ReadyConnectionIds.Clear();

        return game;
    }

    public bool RecordAnswer(string gameCode, string playerName, string answer)
    {
        if (!_sessions.TryGetValue(gameCode, out var session)) return false;
        if (session.ActiveGame is null || session.CurrentQuestion is null) return false;

        session.CurrentQuestion.PlayerAnswers[playerName] = answer;
        session.RoundAnswers[playerName] = answer;
        return true;
    }

    public Game AdvanceRound(string gameCode)
    {
        if (!_sessions.TryGetValue(gameCode, out var session) || session.ActiveGame is null)
        {
            throw new InvalidOperationException($"Cannot advance round: session '{gameCode}' has no active game.");
        }

        var game = session.ActiveGame;
        game.CurrentRound++;
        session.LastAdvancedFromRound = game.CurrentRound - 1;
        session.LastEvaluatedRound = -1;
        session.RoundAnswers.Clear();
        session.ReadyConnectionIds.Clear();
        return game;
    }

    public void ApplyRoundScores(string gameCode, Dictionary<string, int> pointsEarned)
    {
        if (!_sessions.TryGetValue(gameCode, out var session) || session.ActiveGame is null) return;
        foreach (var player in session.ActiveGame.Players)
        {
            if (pointsEarned.TryGetValue(player.Name, out var pts))
            {
                player.Score += pts;
                player.TotalCorrectGuesses += pts > 0 ? 1 : 0;
            }
            player.TotalRoundsPlayed++;
        }
    }

    public void FinishGame(string gameCode)
    {
        if (!_sessions.TryGetValue(gameCode, out var session)) return;
        session.State = SessionState.Finished;
    }

    public string? PromoteNextHost(string gameCode)
    {
        if (!_sessions.TryGetValue(gameCode, out var session) || session.Players.Count == 0) return null;
        var next = session.Players.First();
        session.HostConnectionId = next.ConnectionId;
        return next.Name;
    }

    public GameSession? GetWaitingLobby() =>
        _sessions.Values.FirstOrDefault(s => s.State == SessionState.Waiting && s.Players.Count < 8);

    public LobbyReadyState? MarkPlayerReady(string gameCode, string connectionId)
    {
        if (!_sessions.TryGetValue(gameCode, out var session)) return null;
        session.ReadyConnectionIds.Add(connectionId);
        return BuildReadyState(session);
    }

    public LobbyReadyState? GetLobbyReadyState(string gameCode) =>
        _sessions.TryGetValue(gameCode, out var s) ? BuildReadyState(s) : null;

    public LobbyReadyState? UpdateLobbyAiMode(string gameCode, string connectionId, string aiMode)
    {
        if (!_sessions.TryGetValue(gameCode, out var session)) return null;
        if (session.HostConnectionId != connectionId) return null;
        session.AiMode = string.IsNullOrWhiteSpace(aiMode) ? "Remote" : aiMode;
        return BuildReadyState(session);
    }

    public LobbyReadyState? ResetReadyState(string gameCode)
    {
        if (!_sessions.TryGetValue(gameCode, out var session)) return null;
        session.ReadyConnectionIds.Clear();
        return BuildReadyState(session);
    }

    public GameSession JoinOrCreateLobby(string connectionId, string playerName, DifficultyLevel difficulty, out bool created, string aiMode = "Remote")
    {
        var existing = GetWaitingLobby();
        if (existing is not null)
        {
            created = false;
            var session = JoinLobby(existing.GameCode, connectionId, playerName);
            return session ?? existing;
        }

        created = true;
        return CreateLobby(connectionId, playerName, difficulty, aiMode);
    }

    private static LobbyReadyState BuildReadyState(GameSession s) => new(
        s.GameCode,
        s.Players.Select(p => p.Name).ToList(),
        s.Players.Where(p => s.ReadyConnectionIds.Contains(p.ConnectionId)).Select(p => p.Name).ToList(),
        s.HostName ?? string.Empty,
        s.Difficulty.ToString(),
        s.AiMode,
        s.Players.Count > 0 && s.ReadyConnectionIds.Count >= s.Players.Count,
        MinPlayersToStart);

    // Ensure a joining player's name is unique within the lobby (case-insensitive).
    // Shared "Guest######" identities collide otherwise; append " (2)", " (3)", …
    private static string EnsureUniqueName(GameSession session, string requested)
    {
        var taken = new HashSet<string>(session.Players.Select(p => p.Name), StringComparer.OrdinalIgnoreCase);
        if (!taken.Contains(requested)) return requested;
        for (var i = 2; ; i++)
        {
            var candidate = $"{requested} ({i})";
            if (!taken.Contains(candidate)) return candidate;
        }
    }

    private string GenerateUniqueGameCode()
    {
        const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // skip confusables
        var rng = System.Security.Cryptography.RandomNumberGenerator.Create();
        for (var attempts = 0; attempts < 50; attempts++)
        {
            var bytes = new byte[GameCodeLength];
            rng.GetBytes(bytes);
            var code = new string(bytes.Select(b => alphabet[b % alphabet.Length]).ToArray());
            if (!_sessions.ContainsKey(code)) return code;
        }
        throw new InvalidOperationException("Could not generate a unique game code after 50 attempts.");
    }
}
