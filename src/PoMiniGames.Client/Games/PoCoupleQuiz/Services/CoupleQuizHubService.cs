using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.SignalR.Client;

namespace PoMiniGamesClient.Games.PoCoupleQuiz.Services;

/// <summary>
/// Strongly-typed mirror of the PoCoupleQuiz server contracts. Lives in the client
/// project so the WASM doesn't depend on the host's types. Field shapes match the
/// server payloads exactly (camelCase via JSON).
/// </summary>
public record CoupleQuizGamePlayerState(string Name, bool IsKingPlayer, int Score);

public record CoupleQuizLobbyEventPayload(
    string GameCode,
    bool IsHost,
    string PlayerName,
    List<string> Players,
    List<string> ReadyPlayers,
    string HostName,
    string Difficulty,
    string AiMode = "Remote");

public record CoupleQuizLobbyUpdatedPayload(
    string GameCode,
    List<string> Players,
    List<string> ReadyPlayers,
    string HostName,
    string? Difficulty = null,
    string? AiMode = null);

public record CoupleQuizGameStartedPayload(
    string GameCode,
    string KingPlayerName,
    List<CoupleQuizGamePlayerState> Players,
    string QuestionText,
    string QuestionCategory,
    int RoundIndex,
    int MaxRounds,
    string Difficulty,
    string AiMode = "Remote");

public record CoupleQuizRoundStartedPayload(
    string GameCode,
    int RoundIndex,
    int MaxRounds,
    string KingPlayerName,
    List<CoupleQuizGamePlayerState> Players,
    string QuestionText,
    string QuestionCategory,
    string AiMode = "Remote");

public record CoupleQuizAnswerRecordedPayload(string PlayerName, int RoundIndex);

public record CoupleQuizRoundResultPayload(
    string GameCode,
    int RoundIndex,
    string KingAnswer,
    List<string> MatchedPlayers,
    Dictionary<string, int> Scores,
    Dictionary<string, string> PlayerAnswers,
    List<CoupleQuizGamePlayerState> Players);

public record CoupleQuizGameOverPayload(
    string GameCode,
    IReadOnlyDictionary<string, int> FinalScores,
    List<CoupleQuizGamePlayerState> Players);

public record CoupleQuizHostChangedPayload(string GameCode, string NewHostName);

/// <summary>
/// Client-side wrapper around the <c>/couplequiz/hubs/game</c> SignalR connection.
/// Exposes the server events as C# events for the page to subscribe to. The page
/// should call <see cref="ConnectAsync"/> on init, then <see cref="JoinOrCreateAsync"/>
/// once a name is known.
/// </summary>
public sealed class CoupleQuizHubService : IAsyncDisposable
{
    private readonly NavigationManager _navigation;
    private HubConnection? _connection;

    public event Action<CoupleQuizLobbyEventPayload>? OnLobbyCreated;
    public event Action<CoupleQuizLobbyEventPayload>? OnLobbyJoined;
    public event Action<CoupleQuizLobbyUpdatedPayload>? OnLobbyUpdated;
    public event Action<string>? OnLobbyError;
    public event Action<CoupleQuizGameStartedPayload>? OnGameStarted;
    public event Action<CoupleQuizRoundStartedPayload>? OnRoundStarted;
    public event Action<CoupleQuizAnswerRecordedPayload>? OnAnswerRecorded;
    public event Action<CoupleQuizRoundResultPayload>? OnRoundResult;
    public event Action<CoupleQuizGameOverPayload>? OnGameOver;
    public event Action<string>? OnGameError;
    public event Action<CoupleQuizLobbyUpdatedPayload>? OnPlayerDisconnected;
    public event Action<CoupleQuizHostChangedPayload>? OnHostChanged;

    public CoupleQuizHubService(NavigationManager navigation) => _navigation = navigation;

    public async Task ConnectAsync()
    {
        if (_connection is not null) return;
        var hubUrl = new Uri(new Uri(_navigation.BaseUri), "couplequiz/hubs/game").ToString();
        _connection = new HubConnectionBuilder()
            .WithUrl(hubUrl)
            .WithAutomaticReconnect()
            .Build();

        _connection.On<CoupleQuizLobbyEventPayload>("LobbyCreated", p => OnLobbyCreated?.Invoke(p));
        _connection.On<CoupleQuizLobbyEventPayload>("LobbyJoined", p => OnLobbyJoined?.Invoke(p));
        _connection.On<CoupleQuizLobbyUpdatedPayload>("LobbyUpdated", p => OnLobbyUpdated?.Invoke(p));
        _connection.On<string>("LobbyError", m => OnLobbyError?.Invoke(m));
        _connection.On<CoupleQuizGameStartedPayload>("GameStarted", p => OnGameStarted?.Invoke(p));
        _connection.On<CoupleQuizRoundStartedPayload>("RoundStarted", p => OnRoundStarted?.Invoke(p));
        _connection.On<CoupleQuizAnswerRecordedPayload>("AnswerRecorded", p => OnAnswerRecorded?.Invoke(p));
        _connection.On<CoupleQuizRoundResultPayload>("RoundResult", p => OnRoundResult?.Invoke(p));
        _connection.On<CoupleQuizGameOverPayload>("GameOver", p => OnGameOver?.Invoke(p));
        _connection.On<string>("GameError", m => OnGameError?.Invoke(m));
        _connection.On<CoupleQuizLobbyUpdatedPayload>("PlayerDisconnected", p => OnPlayerDisconnected?.Invoke(p));
        _connection.On<CoupleQuizHostChangedPayload>("HostChanged", p => OnHostChanged?.Invoke(p));

        await _connection.StartAsync();
    }

    public Task CreateLobbyAsync(string playerName, string difficulty, string aiMode = "Remote")
    {
        EnsureConnected();
        return _connection!.InvokeAsync("CreateLobby", playerName, difficulty, aiMode);
    }

    public Task JoinLobbyAsync(string gameCode, string playerName)
    {
        EnsureConnected();
        return _connection!.InvokeAsync("JoinLobby", gameCode, playerName);
    }

    public Task JoinOrCreateAsync(string playerName, string difficulty, string aiMode = "Remote")
    {
        EnsureConnected();
        return _connection!.InvokeAsync("JoinOrCreate", playerName, difficulty, aiMode);
    }

    public Task SetReadyAsync(string gameCode)
    {
        EnsureConnected();
        return _connection!.InvokeAsync("SetReady", gameCode);
    }

    public Task StartGameAsync(string gameCode)
    {
        EnsureConnected();
        return _connection!.InvokeAsync("StartGame", gameCode);
    }

    public Task SubmitAnswerAsync(string gameCode, string answer, int roundIndex)
    {
        EnsureConnected();
        return _connection!.InvokeAsync("SubmitAnswer", gameCode, answer, roundIndex);
    }

    public Task RequestNextRoundAsync(string gameCode)
    {
        EnsureConnected();
        return _connection!.InvokeAsync("RequestNextRound", gameCode);
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
        if (_connection is not null)
        {
            await _connection.DisposeAsync();
        }
    }
}
