using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;

namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// SignalR hub for PoCoupleQuiz: lobby creation / joining / ready-up / start / per-round
/// answer submission / round evaluation / round advancement / game over. Authoritative
/// state lives in <see cref="IGameSessionManager"/> (singleton). Clients are pure views
/// driven by <see cref="IGameClient"/> events.
/// </summary>
/// <remarks>
/// <para>Pattern: <see cref="Hub{IClient}"/> for compile-time safety on every pushed event
/// name. Use cases (request/start/answer/evaluate/next-round) live outside the hub as
/// static helpers so they can be unit-tested in isolation from the SignalR transport.</para>
/// <para>The King is fixed at index 0 of the lobby for the whole game (never rotates) per
/// the 2026 design — see <see cref="Game.AddPlayer"/>.</para>
/// </remarks>
[AllowAnonymous]
public class CoupleQuizHub : Hub<IGameClient>
{
    private readonly IGameSessionManager _sessions;
    private readonly IQuestionService _questionService;
    private readonly ILogger<CoupleQuizHub> _logger;
    private readonly CoupleQuizOptions _options;

    public CoupleQuizHub(
        IGameSessionManager sessions,
        IQuestionService questionService,
        IOptions<CoupleQuizOptions> options,
        ILogger<CoupleQuizHub> logger)
    {
        _sessions = sessions;
        _questionService = questionService;
        _options = options.Value;
        _logger = logger;
    }

    // ── Lobby phase ─────────────────────────────────────────────────────

    public async Task CreateLobby(string playerName, string difficulty, string aiMode = "Remote")
    {
        if (string.IsNullOrWhiteSpace(playerName))
        {
            await Clients.Caller.LobbyError("Player name cannot be empty.");
            return;
        }
        var diff = ParseDifficulty(difficulty);
        var session = _sessions.CreateLobby(Context.ConnectionId, playerName.Trim(), diff, aiMode);
        await Groups.AddToGroupAsync(Context.ConnectionId, session.GameCode);
        _logger.LogInformation("Lobby {Code} created by {Host}", session.GameCode, session.HostName);
        await Clients.Caller.LobbyCreated(BuildLobbyPayload(session, isHost: true));
    }

    public async Task JoinLobby(string gameCode, string playerName)
    {
        if (string.IsNullOrWhiteSpace(playerName) || string.IsNullOrWhiteSpace(gameCode))
        {
            await Clients.Caller.LobbyError("Game code and player name are required.");
            return;
        }
        var session = _sessions.JoinLobby(gameCode.Trim().ToUpperInvariant(), Context.ConnectionId, playerName.Trim());
        if (session is null)
        {
            await Clients.Caller.LobbyError("Could not join. The code may be invalid, the game may have started, or that name is taken.");
            return;
        }
        await Groups.AddToGroupAsync(Context.ConnectionId, session.GameCode);
        var readyNames = session.Players.Where(p => session.ReadyConnectionIds.Contains(p.ConnectionId)).Select(p => p.Name).ToList();
        await Clients.Caller.LobbyJoined(BuildLobbyPayload(session, isHost: false, readyNames));
        await Clients.OthersInGroup(session.GameCode).LobbyUpdated(BuildLobbyUpdatedPayload(session, readyNames));
    }

    public async Task JoinOrCreate(string playerName, string difficulty, string aiMode = "Remote")
    {
        if (string.IsNullOrWhiteSpace(playerName))
        {
            await Clients.Caller.LobbyError("Player name cannot be empty.");
            return;
        }
        var diff = ParseDifficulty(difficulty);
        var session = _sessions.JoinOrCreateLobby(Context.ConnectionId, playerName.Trim(), diff, out var created, aiMode);
        await Groups.AddToGroupAsync(Context.ConnectionId, session.GameCode);
        if (created)
        {
            _logger.LogInformation("JoinOrCreate: lobby {Code} created by {Host}", session.GameCode, session.HostName);
            await Clients.Caller.LobbyCreated(BuildLobbyPayload(session, isHost: true));
        }
        else
        {
            var readyNames = session.Players.Where(p => session.ReadyConnectionIds.Contains(p.ConnectionId)).Select(p => p.Name).ToList();
            await Clients.Caller.LobbyJoined(BuildLobbyPayload(session, isHost: false, readyNames));
            await Clients.OthersInGroup(session.GameCode).LobbyUpdated(BuildLobbyUpdatedPayload(session, readyNames));
        }
    }

    public async Task SetReady(string gameCode)
    {
        if (string.IsNullOrWhiteSpace(gameCode)) return;
        var state = _sessions.MarkPlayerReady(gameCode.Trim().ToUpperInvariant(), Context.ConnectionId);
        if (state is null) return;
        await Clients.Group(state.GameCode).LobbyUpdated(BuildLobbyUpdatedPayload(_sessions.GetSession(state.GameCode)!, state.ReadyPlayers));

        // Auto-start when all players are ready and we have at least 2.
        var session = _sessions.GetSession(state.GameCode);
        if (session is null) return;
        if (state.AllReady && session.Players.Count >= 2)
        {
            await StartGameInternalAsync(session);
        }
    }

    public async Task SetAiMode(string gameCode, string aiMode)
    {
        if (string.IsNullOrWhiteSpace(gameCode)) return;
        var state = _sessions.UpdateLobbyAiMode(gameCode.Trim().ToUpperInvariant(), Context.ConnectionId, aiMode);
        if (state is null) return;
        await Clients.Group(state.GameCode).LobbyUpdated(BuildLobbyUpdatedPayload(_sessions.GetSession(state.GameCode)!, state.ReadyPlayers));
    }

    public async Task StartGame(string gameCode)
    {
        if (string.IsNullOrWhiteSpace(gameCode)) return;
        var session = _sessions.GetSession(gameCode.Trim().ToUpperInvariant());
        if (session is null || session.HostConnectionId != Context.ConnectionId) return;
        if (session.Players.Count < 2)
        {
            await Clients.Caller.GameError("Need at least 2 players to start.");
            return;
        }
        await StartGameInternalAsync(session);
    }

    private async Task StartGameInternalAsync(GameSession session)
    {
        var first = await _questionService.GenerateQuestionAsync(session.Difficulty, category: null, cancellationToken: Context.ConnectionAborted);
        var game = _sessions.StartGame(session.GameCode, first.Text, first.Category.ToString());

        var payload = new GameStartedPayload(
            session.GameCode,
            KingPlayerName: game.KingPlayer?.Name ?? string.Empty,
            Players: game.Players.Select(p => new GamePlayerState(p.Name, p.IsKingPlayer, p.Score)).ToList(),
            QuestionText: first.Text,
            QuestionCategory: first.Category.ToString(),
            RoundIndex: game.CurrentRound,
            MaxRounds: game.MaxRounds,
            Difficulty: game.Difficulty.ToString(),
            AiMode: session.AiMode);
        await Clients.Group(session.GameCode).GameStarted(payload);
    }

    // ── Game phase ──────────────────────────────────────────────────────

    public async Task SubmitAnswer(string gameCode, string answer, int roundIndex)
    {
        if (string.IsNullOrWhiteSpace(gameCode)) return;
        var session = _sessions.GetSession(gameCode.Trim().ToUpperInvariant());
        if (session is null || session.ActiveGame is null || session.CurrentQuestion is null) return;

        var me = session.Players.FirstOrDefault(p => p.ConnectionId == Context.ConnectionId);
        if (me is null) return;
        // The "first to join" player is the King (see Game.AddPlayer — the King never rotates).
        var isKing = Context.ConnectionId == session.Players[0].ConnectionId;
        if (isKing)
        {
            // The King types the SECRET answer. We treat it as the canonical answer for this round.
            session.CurrentQuestion.KingPlayerAnswer = answer;
            session.RoundAnswers[me.Name] = answer;
        }
        else
        {
            _sessions.RecordAnswer(session.GameCode, me.Name, answer);
        }
        await Clients.Group(session.GameCode).AnswerRecorded(new AnswerRecordedPayload(me.Name, roundIndex));
    }

    public async Task RequestNextRound(string gameCode)
    {
        if (string.IsNullOrWhiteSpace(gameCode)) return;
        var session = _sessions.GetSession(gameCode.Trim().ToUpperInvariant());
        if (session is null || session.HostConnectionId != Context.ConnectionId) return;

        // Evaluate the previous round (everyone-vs-King similarity), then advance.
        if (session.ActiveGame is { } game && session.CurrentQuestion is { } q)
        {
            if (q.KingPlayerAnswer is not null)
            {
                var points = new Dictionary<string, int>();
                foreach (var p in game.Players.Where(x => !x.IsKingPlayer))
                {
                    if (!q.PlayerAnswers.TryGetValue(p.Name, out var guess)) continue;
                    var sim = await _questionService.CheckAnswerSimilarityAsync(q.KingPlayerAnswer, guess, Context.ConnectionAborted);
                    points[p.Name] = sim >= 0.5f ? 10 : 0; // match threshold
                    if (points[p.Name] > 0) p.TotalCorrectGuesses++;
                }
                _sessions.ApplyRoundScores(session.GameCode, points);
                await Clients.Group(session.GameCode).RoundResult(new RoundResultPayload(
                    session.GameCode,
                    RoundIndex: game.CurrentRound,
                    KingAnswer: q.KingPlayerAnswer,
                    MatchedPlayers: points.Where(kv => kv.Value > 0).Select(kv => kv.Key).ToList(),
                    Scores: game.GetScoreboard(),
                    PlayerAnswers: new Dictionary<string, string>(q.PlayerAnswers),
                    Players: game.Players.Select(p => new GamePlayerState(p.Name, p.IsKingPlayer, p.Score)).ToList()));
            }
        }

        var next = _sessions.AdvanceRound(session.GameCode);
        if (next.IsGameOver)
        {
            _sessions.FinishGame(session.GameCode);
            await Clients.Group(session.GameCode).GameOver(new GameOverPayload(
                session.GameCode,
                FinalScores: next.GetScoreboard(),
                Players: next.Players.Select(p => new GamePlayerState(p.Name, p.IsKingPlayer, p.Score)).ToList()));
            return;
        }

        // Generate a new question for the next round.
        var newQ = await _questionService.GenerateQuestionAsync(next.Difficulty, category: null, cancellationToken: Context.ConnectionAborted);
        if (session.CurrentQuestion is not null)
        {
            session.CurrentQuestion.Text = newQ.Text;
            session.CurrentQuestion.Category = newQ.Category;
            session.CurrentQuestion.KingPlayerAnswer = null;
            session.CurrentQuestion.PlayerAnswers.Clear();
            session.CurrentQuestion.PlayersMatched.Clear();
        }
        await Clients.Group(session.GameCode).RoundStarted(new RoundStartedPayload(
            session.GameCode,
            RoundIndex: next.CurrentRound,
            MaxRounds: next.MaxRounds,
            KingPlayerName: next.KingPlayer?.Name ?? string.Empty,
            Players: next.Players.Select(p => new GamePlayerState(p.Name, p.IsKingPlayer, p.Score)).ToList(),
            QuestionText: newQ.Text,
            QuestionCategory: newQ.Category.ToString(),
            AiMode: session.AiMode));
    }

    public async Task SubmitHighScore(string gameCode, int finalScore)
    {
        // Reserved for future persistence hook (used by client to broadcast post-game score).
        await Task.CompletedTask;
    }

    public async Task RequestRestart(string gameCode)
    {
        if (string.IsNullOrWhiteSpace(gameCode)) return;
        _sessions.ResetReadyState(gameCode.Trim().ToUpperInvariant());
        var session = _sessions.GetSession(gameCode.Trim().ToUpperInvariant());
        if (session is null) return;
        session.State = SessionState.Waiting;
        session.ActiveGame = null;
        session.CurrentQuestion = null;
        var readyNames = session.Players.Where(p => session.ReadyConnectionIds.Contains(p.ConnectionId)).Select(p => p.Name).ToList();
        await Clients.Group(session.GameCode).LobbyUpdated(BuildLobbyUpdatedPayload(session, readyNames));
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var session = _sessions.RemovePlayer(Context.ConnectionId, out var sessionEmpty);
        if (session is null) return;

        if (sessionEmpty) return;

        var readyNames = session.Players.Where(p => session.ReadyConnectionIds.Contains(p.ConnectionId)).Select(p => p.Name).ToList();
        await Clients.Group(session.GameCode).PlayerDisconnected(BuildLobbyUpdatedPayload(session, readyNames));
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private static DifficultyLevel ParseDifficulty(string? raw) =>
        Enum.TryParse<DifficultyLevel>(raw, ignoreCase: true, out var d) ? d : DifficultyLevel.Medium;

    private static LobbyEventPayload BuildLobbyPayload(GameSession s, bool isHost, List<string>? readyNames = null)
    {
        readyNames ??= s.Players.Where(p => s.ReadyConnectionIds.Contains(p.ConnectionId)).Select(p => p.Name).ToList();
        var me = s.Players.FirstOrDefault(p => p.ConnectionId == s.HostConnectionId);
        return new LobbyEventPayload(
            s.GameCode,
            isHost,
            me?.Name ?? string.Empty,
            s.Players.Select(p => p.Name).ToList(),
            readyNames,
            s.HostName ?? string.Empty,
            s.Difficulty.ToString(),
            s.AiMode);
    }

    private static LobbyUpdatedPayload BuildLobbyUpdatedPayload(GameSession s, List<string> readyNames) =>
        new(s.GameCode,
            s.Players.Select(p => p.Name).ToList(),
            readyNames,
            s.HostName ?? string.Empty,
            s.Difficulty.ToString(),
            s.AiMode);
}
