using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.SignalR.Client;

namespace PoMiniGamesClient.Games.PoFunQuiz.Services;

// ── Wire-format records (mirror server contracts) ──────────────────────────

public record FunQuizPlayerStateDto(string Name, int Score, int Streak);

public record FunQuizGameStateDto(
    string GameId,
    string HostName,
    string State,
    List<FunQuizPlayerStateDto> Players,
    List<FunQuizQuestionDto> Questions,
    int CurrentQuestionIndex,
    string Category,
    int SecondsPerQuestion);

public record FunQuizQuestionDto(
    string Text,
    List<string> Options,
    int CorrectOptionIndex,
    string Category,
    int BasePoints);

public record FunQuizScoreUpdateDto(string GameId, string PlayerName, int TotalScore, int Streak, int MaxStreak);

public record FunQuizGameFinishedDto(string GameId, IReadOnlyDictionary<string, int> FinalScores, FunQuizPlayerStateDto? Winner, bool IsTie);

public record FunQuizLobbyPlayerJoinedDto(string GameId, string PlayerName, List<string> Players);

public record FunQuizLobbyErrorDto(string GameCode, string Message);

public record FunQuizLobbySummaryDto(string GameId, string HostName, List<string> Players, int PlayerCount, string State, string Category);

/// <summary>
/// Client-side wrapper over <c>/funquiz/gamehub</c>. Two-player SignalR trivia:
/// CreateGame → JoinGame → StartGame → UpdateScore loop → PlayerFinished →
/// GameFinished.
/// </summary>
public sealed class FunQuizHubService : IAsyncDisposable
{
    private readonly NavigationManager _navigation;
    private HubConnection? _connection;

    public event Action<FunQuizGameStateDto>? OnGameCreated;
    public event Action<FunQuizGameStateDto>? OnGameJoined;
    public event Action<FunQuizGameStateDto>? OnGameUpdated;
    public event Action<FunQuizGameStateDto>? OnGameStarted;
    public event Action<FunQuizScoreUpdateDto>? OnScoreUpdated;
    public event Action<FunQuizLobbyPlayerJoinedDto>? OnPlayerJoined;
    public event Action<FunQuizGameFinishedDto>? OnGameFinished;
    public event Action<FunQuizLobbyErrorDto>? OnLobbyError;

    // Connection lifecycle events (consumed by the page to render a
    // "Reconnecting…" banner so players know the lobby is healing, not dead).
    public event Action<Exception?>? OnReconnecting;
    public event Action<string?>? OnReconnected;
    public event Action<Exception?>? OnClosed;

    public bool IsReconnecting { get; private set; }

    public FunQuizHubService(NavigationManager navigation) => _navigation = navigation;

    public async Task ConnectAsync()
    {
        if (_connection is not null && _connection.State != HubConnectionState.Disconnected) return;
        var url = new Uri(new Uri(_navigation.BaseUri), "funquiz/gamehub").ToString();
        _connection = new HubConnectionBuilder()
            .WithUrl(url)
            .WithAutomaticReconnect(new[] { TimeSpan.FromSeconds(0), TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(3), TimeSpan.FromSeconds(5) })
            .Build();
        _connection.On<FunQuizGameStateDto>("GameCreated", p => OnGameCreated?.Invoke(p));
        _connection.On<FunQuizGameStateDto>("GameJoined", p => OnGameJoined?.Invoke(p));
        _connection.On<FunQuizGameStateDto>("GameUpdated", p => OnGameUpdated?.Invoke(p));
        _connection.On<FunQuizGameStateDto>("GameStarted", p => OnGameStarted?.Invoke(p));
        _connection.On<FunQuizScoreUpdateDto>("ScoreUpdated", p => OnScoreUpdated?.Invoke(p));
        _connection.On<FunQuizLobbyPlayerJoinedDto>("PlayerJoined", p => OnPlayerJoined?.Invoke(p));
        _connection.On<FunQuizGameFinishedDto>("GameFinished", p => OnGameFinished?.Invoke(p));
        _connection.On<FunQuizLobbyErrorDto>("LobbyError", p => OnLobbyError?.Invoke(p));

        // Surface reconnect lifecycle so the UI can show a "Reconnecting…"
        // banner instead of leaving the player staring at a dead lobby.
        _connection.Reconnecting += ex =>
        {
            OnReconnecting?.Invoke(ex);
            return Task.CompletedTask;
        };
        _connection.Reconnected += id =>
        {
            OnReconnected?.Invoke(id);
            return Task.CompletedTask;
        };
        _connection.Closed += ex =>
        {
            OnClosed?.Invoke(ex);
            return Task.CompletedTask;
        };
        await _connection.StartAsync();
    }

    public Task CreateGame(string playerName, string category, int questionCount = 10)
    {
        EnsureConnected();
        return _connection!.InvokeAsync("CreateGame", playerName, category, questionCount);
    }

    public Task JoinGame(string gameId, string playerName)
    {
        EnsureConnected();
        return _connection!.InvokeAsync("JoinGame", gameId, playerName);
    }

    public Task StartGame(string gameId)
    {
        EnsureConnected();
        return _connection!.InvokeAsync("StartGame", gameId);
    }

    public Task UpdateScore(string gameId, bool isCorrect, double speedMultiplier, int secondsRemaining)
    {
        EnsureConnected();
        return _connection!.InvokeAsync("UpdateScore", gameId, isCorrect, speedMultiplier, secondsRemaining);
    }

    public Task PlayerFinished(string gameId)
    {
        EnsureConnected();
        return _connection!.InvokeAsync("PlayerFinished", gameId);
    }

    public Task AdvanceQuestion(string gameId)
    {
        EnsureConnected();
        return _connection!.InvokeAsync("AdvanceQuestion", gameId);
    }

    private void EnsureConnected()
    {
        if (_connection is null || _connection.State != HubConnectionState.Connected)
        {
            throw new InvalidOperationException("Hub connection is not active. Call ConnectAsync first.");
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_connection is not null) await _connection.DisposeAsync();
    }
}
