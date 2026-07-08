using System.Collections.Concurrent;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// In-memory registry of open PoFunQuiz multiplayer games. Sessions do NOT
/// survive restarts; for the consolidation MVP a single-process model is
/// sufficient. The reaper background service is intentionally not included —
/// idle rooms are cleaned up when the host disconnects.
/// </summary>
public class MultiplayerLobbyService(IOpenAIService ai, ILogger<MultiplayerLobbyService> logger)
{
    private readonly ConcurrentDictionary<string, MultiplayerGame> _games = new();
    private readonly ConcurrentDictionary<string, string> _connectionToGame = new();
    private readonly IOpenAIService _ai = ai;
    private readonly ILogger<MultiplayerLobbyService> _logger = logger;

    public async Task<MultiplayerGame> CreateAsync(string hostConnectionId, string hostName, QuestionCategory category, int questionCount, CancellationToken ct)
    {
        var game = new MultiplayerGame
        {
            GameId = Guid.NewGuid().ToString("N").Substring(0, 6).ToUpperInvariant(),
            Category = category,
            HostConnectionId = hostConnectionId,
            State = GameState.Waiting,
            Players = new List<MultiplayerPlayer>
            {
                new() { ConnectionId = hostConnectionId, Name = hostName, PlayerNumber = 1 }
            },
            Questions = (await _ai.GenerateQuizQuestionsAsync(category, questionCount, ct)).ToList()
        };
        _games[game.GameId] = game;
        _connectionToGame[hostConnectionId] = game.GameId;
        return game;
    }

    public MultiplayerGame? Join(string gameId, string connectionId, string playerName)
    {
        if (!_games.TryGetValue(gameId, out var game)) return null;
        if (game.State != GameState.Waiting) return null;
        if (game.Players.Count >= 2) return null; // 2-player only
        // If this connection re-joins, drop the old slot first.
        game.Players.RemoveAll(p => p.ConnectionId == connectionId);
        game.Players.Add(new MultiplayerPlayer
        {
            ConnectionId = connectionId,
            Name = playerName,
            PlayerNumber = game.Players.Count + 1
        });
        _connectionToGame[connectionId] = game.GameId;
        return game;
    }

    public MultiplayerGame? GetByConnection(string connectionId) =>
        _connectionToGame.TryGetValue(connectionId, out var id) && _games.TryGetValue(id, out var g) ? g : null;

    public IReadOnlyList<FunQuizLobbySummary> ListOpen()
    {
        return _games.Values
            .Where(g => g.State == GameState.Waiting && g.Players.Count == 1)
            .Select(g => new FunQuizLobbySummary(
                g.GameId, g.Players[0].Name, g.Players.Select(p => p.Name).ToList(),
                g.Players.Count, g.State, g.Category.ToString()))
            .ToList();
    }

    public void RemovePlayer(string connectionId, out bool sessionEmpty)
    {
        sessionEmpty = false;
        if (!_connectionToGame.TryRemove(connectionId, out var gameId)) return;
        if (!_games.TryGetValue(gameId, out var game)) return;
        game.Players.RemoveAll(p => p.ConnectionId == connectionId);
        if (game.Players.Count == 0)
        {
            _games.TryRemove(gameId, out _);
            sessionEmpty = true;
            return;
        }
        // Host left → promote the remaining player to host.
        if (game.HostConnectionId == connectionId)
        {
            game.HostConnectionId = game.Players[0].ConnectionId;
        }
    }

    public bool StartGame(string gameId, string requesterConnectionId)
    {
        if (!_games.TryGetValue(gameId, out var game)) return false;
        if (game.HostConnectionId != requesterConnectionId) return false;
        if (game.Players.Count < 2) return false;
        game.State = GameState.InProgress;
        game.StartTime = DateTime.UtcNow;
        return true;
    }

    public bool UpdateScore(string gameId, string connectionId, bool isCorrect, double speedMultiplier, int secondsRemaining)
    {
        if (!_games.TryGetValue(gameId, out var game)) return false;
        var player = game.Players.FirstOrDefault(p => p.ConnectionId == connectionId);
        if (player is null) return false;
        if (game.Questions.Count == 0) return false;
        var basePoints = game.Questions[Math.Min(game.CurrentQuestionIndex, game.Questions.Count - 1)].BasePoints;
        if (isCorrect)
        {
            player.ScoreState.ApplyCorrectAnswer(basePoints, speedMultiplier);
            player.ScoreState.SetTimeBonus(player.ScoreState.TimeBonus + (int)Math.Round((double)secondsRemaining * 10));
        }
        else
        {
            player.ScoreState.ResetStreak();
        }
        player.Score = player.ScoreState.TotalScore;
        return true;
    }

    public bool AdvanceQuestion(string gameId, string requesterConnectionId)
    {
        if (!_games.TryGetValue(gameId, out var game)) return false;
        if (game.HostConnectionId != requesterConnectionId) return false;
        game.CurrentQuestionIndex++;
        // §Best-practice (2026-07-07): reset per-question flags so a player
        // who already answered can submit their next answer for the new
        // question. Without this, PlayerFinished() in the hub returns early
        // after the first question because HasFinished was set permanently.
        foreach (var p in game.Players) p.HasFinished = false;
        return true;
    }

    public bool FinishGame(string gameId)
    {
        if (!_games.TryGetValue(gameId, out var game)) return false;
        game.State = GameState.Finished;
        game.EndTime = DateTime.UtcNow;
        return true;
    }
}

public class MultiplayerPlayer
{
    public string ConnectionId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public int PlayerNumber { get; set; }
    public int Score { get; set; }
    public PlayerScoreState ScoreState { get; } = new();
    public int CurrentStreak => ScoreState.CurrentStreak;
    public int MaxStreak => ScoreState.MaxStreak;
    public bool HasFinished { get; set; }
}

public class MultiplayerGame
{
    public string GameId { get; set; } = string.Empty;
    public string HostConnectionId { get; set; } = string.Empty;
    public QuestionCategory Category { get; set; } = QuestionCategory.General;
    public List<QuizQuestion> Questions { get; set; } = new();
    public List<MultiplayerPlayer> Players { get; set; } = new();
    public GameState State { get; set; } = GameState.Waiting;
    public int CurrentQuestionIndex { get; set; }
    public DateTime? StartTime { get; set; }
    public DateTime? EndTime { get; set; }
    public bool IsComplete => State == GameState.Finished || CurrentQuestionIndex >= Questions.Count;
    public MultiplayerPlayer? Winner =>
        Players.Count == 0 ? null :
        Players[0].Score == Players[1].Score ? null :
        Players.OrderByDescending(p => p.Score).First();
    public bool IsTie => Players.Count == 2 && Players[0].Score == Players[1].Score;
}
