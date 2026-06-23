namespace PoMiniGames.Features.PoCoupleQuiz;

// ── Enums ───────────────────────────────────────────────────────────────────

public enum DifficultyLevel
{
    Easy,
    Medium,
    Hard
}

public enum SessionState
{
    Waiting,
    InProgress,
    Finished
}

public enum QuestionCategory
{
    Relationships,
    Hobbies,
    Childhood,
    Future,
    Preferences,
    Values
}

// ── Player & Question ───────────────────────────────────────────────────────

public class Player
{
    public string Name { get; set; } = string.Empty;
    public int Score { get; set; }
    public bool IsKingPlayer { get; set; }
    public int TotalRoundsPlayed { get; set; }
    public int TotalCorrectGuesses { get; set; }
}

public class Question
{
    public string Text { get; set; } = string.Empty;
    public QuestionCategory Category { get; set; }
}

public class GameQuestion
{
    public string Text { get; set; } = string.Empty;
    public QuestionCategory Category { get; set; }
    public string? KingPlayerAnswer { get; set; }
    public Dictionary<string, string> PlayerAnswers { get; set; } = new();
    public HashSet<string> PlayersMatched { get; set; } = new();

    public bool HasPlayerAnswered(string playerName) => PlayerAnswers.ContainsKey(playerName);
}

public class Game
{
    public string GameSessionId { get; set; } = Guid.NewGuid().ToString();
    public List<Player> Players { get; set; } = new();
    public int CurrentKingPlayerIndex { get; set; } = 0;
    public Player? KingPlayer => Players.Any() ? Players[CurrentKingPlayerIndex] : null;
    public List<GameQuestion> Questions { get; set; } = new();
    public int CurrentRound { get; set; }
    public DifficultyLevel Difficulty { get; set; } = DifficultyLevel.Medium;
    public int MaxRounds => Difficulty switch
    {
        DifficultyLevel.Easy => 3,
        DifficultyLevel.Medium => 5,
        DifficultyLevel.Hard => 7,
        _ => 5
    };
    public bool IsGameOver => CurrentRound >= MaxRounds;
    public int MinimumPlayers => 2;
    public bool HasEnoughPlayers => Players.Count >= MinimumPlayers;

    public Dictionary<string, int> GetScoreboard()
    {
        // Scoreboard includes everyone except the King (King is the "subject" — never a competitor).
        var scores = new Dictionary<string, int>();
        foreach (var player in Players.Where(p => !p.IsKingPlayer))
        {
            scores[player.Name] = player.Score;
        }
        return scores.OrderByDescending(s => s.Value)
                    .ToDictionary(pair => pair.Key, pair => pair.Value);
    }

    public void AddPlayer(Player player)
    {
        Players.Add(player);
        if (Players.Count == 1 && player.IsKingPlayer)
        {
            CurrentKingPlayerIndex = 0;
        }
    }

    // The King never rotates: the first player in the lobby stays King for the entire game.

    public bool AllPlayersAnswered(int roundIndex)
    {
        if (roundIndex >= Questions.Count) return false;
        var question = Questions[roundIndex];
        return Players.Where(p => !p.IsKingPlayer)
                     .All(p => question.HasPlayerAnswered(p.Name));
    }
}

// ── Session (in-memory lobby state, not persisted) ──────────────────────────

public record LobbyPlayer(string Name, string ConnectionId);

public class GameSession
{
    public string GameCode { get; init; } = string.Empty;
    public string HostConnectionId { get; set; } = string.Empty;
    public DifficultyLevel Difficulty { get; set; } = DifficultyLevel.Medium;
    public string AiMode { get; set; } = "Remote";
    public SessionState State { get; set; } = SessionState.Waiting;
    public List<LobbyPlayer> Players { get; set; } = new();
    public Game? ActiveGame { get; set; }
    public GameQuestion? CurrentQuestion { get; set; }
    public Dictionary<string, string?> RoundAnswers { get; set; } = new();
    public int LastEvaluatedRound { get; set; } = -1;
    public int LastAdvancedFromRound { get; set; } = -1;
    public HashSet<string> ReadyConnectionIds { get; set; } = new(StringComparer.Ordinal);
    public string? HostName => Players.FirstOrDefault(p => p.ConnectionId == HostConnectionId)?.Name;
}

public record LobbyReadyState(
    string GameCode,
    List<string> Players,
    List<string> ReadyPlayers,
    string HostName,
    string Difficulty,
    string AiMode,
    bool AllReady,
    int MinPlayersToStart);
