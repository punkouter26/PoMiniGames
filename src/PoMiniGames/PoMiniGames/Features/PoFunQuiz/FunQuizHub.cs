using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// SignalR hub for PoFunQuiz multiplayer. Two-player trivia battle. Authoritative
/// state lives in <see cref="MultiplayerLobbyService"/> (singleton). Clients are
/// pure views driven by <see cref="IFunQuizClient"/> events.
/// </summary>
[AllowAnonymous]
public class FunQuizHub : Hub<IFunQuizClient>
{
    private readonly MultiplayerLobbyService _lobby;
    private readonly ILogger<FunQuizHub> _logger;

    public FunQuizHub(MultiplayerLobbyService lobby, ILogger<FunQuizHub> logger)
    {
        _lobby = lobby;
        _logger = logger;
    }

    public async Task CreateGame(string playerName, string category, int questionCount = 10)
    {
        if (string.IsNullOrWhiteSpace(playerName))
        {
            await Clients.Caller.LobbyError(new FunQuizLobbyError(string.Empty, "Player name is required."));
            return;
        }
        var cat = Enum.TryParse<QuestionCategory>(category, true, out var c) ? c : QuestionCategory.General;
        questionCount = Math.Clamp(questionCount, 1, 50);
        var game = await _lobby.CreateAsync(Context.ConnectionId, playerName.Trim(), cat, questionCount, Context.ConnectionAborted);
        await Groups.AddToGroupAsync(Context.ConnectionId, game.GameId);
        _logger.LogInformation("PoFunQuiz game {Code} created by {Host}", game.GameId, playerName);
        await Clients.Caller.GameCreated(BuildState(game));
    }

    public async Task JoinGame(string gameId, string playerName)
    {
        if (string.IsNullOrWhiteSpace(gameId) || string.IsNullOrWhiteSpace(playerName))
        {
            await Clients.Caller.LobbyError(new FunQuizLobbyError(gameId ?? string.Empty, "Game code and player name are required."));
            return;
        }
        var normalized = gameId.Trim().ToUpperInvariant();
        var game = _lobby.Join(normalized, Context.ConnectionId, playerName.Trim());
        if (game is null)
        {
            await Clients.Caller.LobbyError(new FunQuizLobbyError(normalized, "Could not join. Check the code and try again."));
            return;
        }
        await Groups.AddToGroupAsync(Context.ConnectionId, game.GameId);
        _logger.LogInformation("PoFunQuiz {Code}: {Name} joined", game.GameId, playerName);
        await Clients.Caller.GameJoined(BuildState(game));
        await Clients.OthersInGroup(game.GameId).PlayerJoined(new FunQuizLobbyPlayerJoined(
            game.GameId, playerName, game.Players.Select(p => p.Name).ToList()));
    }

    public async Task GetOpenGames()
    {
        // Reserved for the lobby browser; clients can also call
        // /api/funquiz/lobby/open (the HTTP version below).
        await Task.CompletedTask;
    }

    public async Task StartGame(string gameId)
    {
        if (string.IsNullOrWhiteSpace(gameId)) return;
        var normalized = gameId.Trim().ToUpperInvariant();
        if (!_lobby.StartGame(normalized, Context.ConnectionId)) return;
        var game = _lobby.GetByConnection(Context.ConnectionId);
        if (game is null) return;
        await Clients.Group(game.GameId).GameStarted(BuildState(game));
    }

    public async Task UpdateScore(string gameId, bool isCorrect, double speedMultiplier, int secondsRemaining)
    {
        if (string.IsNullOrWhiteSpace(gameId)) return;
        var normalized = gameId.Trim().ToUpperInvariant();
        if (!_lobby.UpdateScore(normalized, Context.ConnectionId, isCorrect, speedMultiplier, secondsRemaining)) return;
        var game = _lobby.GetByConnection(Context.ConnectionId);
        if (game is null) return;
        var player = game.Players.FirstOrDefault(p => p.ConnectionId == Context.ConnectionId);
        if (player is null) return;
        await Clients.Group(game.GameId).ScoreUpdated(new FunQuizScoreUpdate(
            game.GameId, player.Name, player.Score, player.CurrentStreak, player.MaxStreak));
    }

    public async Task PlayerFinished(string gameId)
    {
        if (string.IsNullOrWhiteSpace(gameId)) return;
        var normalized = gameId.Trim().ToUpperInvariant();
        var game = _lobby.GetByConnection(Context.ConnectionId);
        if (game is null || game.GameId != normalized) return;
        // Mark this player as finished for the *current* question. When both
        // have finished the question, advance. Once we've burned through every
        // question, declare the winner.
        var me = game.Players.FirstOrDefault(p => p.ConnectionId == Context.ConnectionId);
        if (me is null) return;
        if (me.HasFinished) return; // already submitted for this question
        me.HasFinished = true;
        await Clients.Group(game.GameId).PlayerFinishedQuestion(new FunQuizPlayerFinishedQuestion(
            game.GameId, me.Name, game.Players.Count(p => p.HasFinished), game.Players.Count));

        if (game.Players.Count == 2 && game.Players.All(p => p.HasFinished))
        {
            if (game.CurrentQuestionIndex >= game.Questions.Count - 1)
            {
                // All questions consumed → declare the final winner.
                _lobby.FinishGame(game.GameId);
                var scores = game.Players.ToDictionary(p => p.Name, p => p.Score);
                var winner = game.Winner;
                var payload = new FunQuizGameFinished(
                    game.GameId, scores,
                    winner is null ? null : new FunQuizPlayerState(winner.Name, winner.Score, winner.MaxStreak),
                    game.IsTie);
                await Clients.Group(game.GameId).GameFinished(payload);
            }
            else
            {
                // Advance to the next question. HasFinished is reset inside
                // MultiplayerLobbyService.AdvanceQuestion.
                _lobby.AdvanceQuestion(game.GameId, Context.ConnectionId);
                var fresh = _lobby.GetByConnection(Context.ConnectionId);
                if (fresh is not null)
                {
                    await Clients.Group(fresh.GameId).GameUpdated(BuildState(fresh));
                }
            }
        }
    }

    public async Task AdvanceQuestion(string gameId)
    {
        if (string.IsNullOrWhiteSpace(gameId)) return;
        var normalized = gameId.Trim().ToUpperInvariant();
        if (!_lobby.AdvanceQuestion(normalized, Context.ConnectionId)) return;
        var game = _lobby.GetByConnection(Context.ConnectionId);
        if (game is null) return;
        await Clients.Group(game.GameId).GameUpdated(BuildState(game));
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var game = _lobby.GetByConnection(Context.ConnectionId);
        _lobby.RemovePlayer(Context.ConnectionId, out var empty);
        if (game is null || empty) return;
        await Clients.Group(game.GameId).GameUpdated(BuildState(game));
    }

    private static FunQuizGameState BuildState(MultiplayerGame g) => new(
        g.GameId,
        g.Players.FirstOrDefault(p => p.ConnectionId == g.HostConnectionId)?.Name ?? string.Empty,
        g.State,
        g.Players.Select(p => new FunQuizPlayerState(p.Name, p.Score, p.CurrentStreak)).ToList(),
        g.Questions,
        g.CurrentQuestionIndex,
        g.Category.ToString(),
        SecondsPerQuestion: 30);
}
