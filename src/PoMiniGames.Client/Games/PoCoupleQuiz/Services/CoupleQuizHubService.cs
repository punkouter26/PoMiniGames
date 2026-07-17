using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGamesClient.Services;

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
    private readonly ApiEndpoints _endpoints;
    private HubConnection? _connection;

    /// <summary>
    /// The most recent <c>GameStarted</c> payload, buffered so the game page can
    /// initialise from it. The lobby page consumes the live event to navigate to
    /// <c>/couplequiz/game</c>; by the time that page mounts and subscribes, the
    /// live event has already fired — so it reads this buffer instead. Cleared on
    /// game-over so a stale game can't leak into the next lobby session.
    /// </summary>
    public CoupleQuizGameStartedPayload? LastGameStarted { get; private set; }

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

    public CoupleQuizHubService(NavigationManager navigation, ApiEndpoints endpoints) =>
        (_navigation, _endpoints) = (navigation, endpoints);

    public async Task ConnectAsync()
    {
        if (_connection is not null) return;
        // §Absolute URL: SignalR ignores the DI HttpClient BaseAddress, so we
        // compose against ApiEndpoints.ApiBase — the API host (:5000), not the
        // WASM host (:5261). Without this, the standalone client hits
        // /couplequiz/hubs/game/negotiate on :5261 and gets a 405.
        var hubUrl = _endpoints.Hub("couplequiz/hubs/game");
        _connection = new HubConnectionBuilder()
            .WithUrl(hubUrl, options =>
            {
                // §2026-07-16: SignalR's default HttpClientFactory doesn't flow
                // through DI, so the negotiate POST drops the dev cookie and the
                // hub's RequireAuthorization() returns 401. Force the credentials
                // handler so the PoMiniGames.DevAuth cookie round-trips.
                options.HttpMessageHandlerFactory = SignalRCredentialsHttpClientFactory.CreateHandler;
            })
            .WithAutomaticReconnect()
            .Build();

        _connection.On<CoupleQuizLobbyEventPayload>("LobbyCreated", p => OnLobbyCreated?.Invoke(p));
        _connection.On<CoupleQuizLobbyEventPayload>("LobbyJoined", p => OnLobbyJoined?.Invoke(p));
        _connection.On<CoupleQuizLobbyUpdatedPayload>("LobbyUpdated", p => OnLobbyUpdated?.Invoke(p));
        _connection.On<string>("LobbyError", m => OnLobbyError?.Invoke(m));
        _connection.On<CoupleQuizGameStartedPayload>("GameStarted", p =>
        {
            // Buffer first, THEN raise — the game page reads the buffer on mount.
            LastGameStarted = p;
            OnGameStarted?.Invoke(p);
        });
        _connection.On<CoupleQuizRoundStartedPayload>("RoundStarted", p => OnRoundStarted?.Invoke(p));
        _connection.On<CoupleQuizAnswerRecordedPayload>("AnswerRecorded", p => OnAnswerRecorded?.Invoke(p));
        _connection.On<CoupleQuizRoundResultPayload>("RoundResult", p => OnRoundResult?.Invoke(p));
        _connection.On<CoupleQuizGameOverPayload>("GameOver", p =>
        {
            LastGameStarted = null; // don't let a finished game re-hydrate a new page
            OnGameOver?.Invoke(p);
        });
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
