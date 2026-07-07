using System.Net.Http;
using System.Net.Http.Json;
using PoMiniGamesClient.Services;
using PoShared.Games.PoJoker;

namespace PoMiniGamesClient.Games.PoJoker;

/// <summary>
/// Orchestrates the autonomous performance loop for the Jester Stage (demo mode):
/// fetch joke → show setup → AI predicts punchline → reveal → transition, capped at 10 jokes.
/// Separates business logic from the UI component (single responsibility). Ported from the
/// standalone PoJoker app; API paths retargeted to the PoMiniGames host's <c>/api/joker/*</c>.
/// </summary>
public sealed class PerformanceOrchestrator : IAsyncDisposable
{
    private readonly HttpClient _http;
    private readonly IJokerSpeechService _speechService;
    private readonly IJokerAudioService _audioService;
    private readonly PerformanceSettings _settings;
    private CancellationTokenSource? _cts;
    private Task? _performanceLoopTask;
    private bool _isRunning;

    public string SessionId { get; } = GenerateMedievalAlias();

    private static string GenerateMedievalAlias()
    {
        string[] adjectives = ["Swift", "Bold", "Mighty", "Cunning", "Noble", "Witty", "Brave", "Fierce",
                                "Wise", "Jolly", "Merry", "Grand", "Iron", "Silver", "Golden", "Dark",
                                "Bright", "Grim", "Lucky", "Fair"];
        string[] titles = ["Jester", "Knight", "Fool", "Baron", "Herald", "Squire", "Bard", "Sage",
                           "Rogue", "Archer", "Mage", "Smith", "Drake", "Hawk", "Fox", "Wolf",
                           "Bear", "Raven", "Crane", "Swan"];
        var rng = Random.Shared;
        return $"{adjectives[rng.Next(adjectives.Length)]}{titles[rng.Next(titles.Length)]}-{Guid.NewGuid().ToString("N")[..4]}";
    }

    public PerformanceState CurrentState { get; private set; } = PerformanceState.Idle;
    public JokeDto? CurrentJoke { get; private set; }
    public JokeAnalysisDto? CurrentAnalysis { get; private set; }
    public int SessionTriumphs { get; private set; }
    public int SessionDefeats { get; private set; }
    public bool IsRunning => _isRunning;
    public List<int> SeenJokeIds { get; } = [];

    // Mood/category selection — set by JesterStage before starting.
    public string SelectedCategory { get; set; } = "Any";
    public bool SelectedSafeMode { get; set; }
    public string SelectedMoodLabel { get; set; } = "Royal Court";

    // Demo mode: 10 jokes per show.
    private const int MaxJokesPerShow = 10;
    public int JokesDisplayed { get; private set; }
    public bool IsShowComplete { get; private set; }
    public List<JokeAnalysisDto> TopJokes { get; } = [];

    // Error handling state.
    public bool ShowNetworkOverlay { get; private set; }
    public string NetworkStatusText { get; private set; } = "Searching for a path to the server...";
    public bool IsRetrying { get; private set; }
    public int RetryCount { get; private set; }

    public event Action? StateChanged;

    public PerformanceOrchestrator(
        HttpClient http,
        IJokerSpeechService speechService,
        IJokerAudioService audioService,
        PerformanceSettings? settings = null)
    {
        _http = http;
        _speechService = speechService;
        _audioService = audioService;
        _settings = settings ?? new PerformanceSettings();
        _settings.Validate();
    }

    public async Task StartAsync()
    {
        _isRunning = true;
        _cts = new CancellationTokenSource();

        try
        {
            await _audioService.InitializeAsync();
            _performanceLoopTask = RunPerformanceLoopAsync(_cts.Token);
            await _performanceLoopTask;
        }
        catch (OperationCanceledException)
        {
            // Expected when StopAsync() cancels the token.
        }
        finally
        {
            _isRunning = false;
            NotifyStateChanged();
        }
    }

    public async Task StopAsync()
    {
        _isRunning = false;
        _cts?.Cancel();
        CurrentState = PerformanceState.Idle;

        try { await _speechService.StopAsync(); }
        catch { /* ignore errors during stop */ }

        if (_performanceLoopTask is not null)
        {
            try { await _performanceLoopTask; }
            catch (OperationCanceledException) { /* expected */ }
        }

        NotifyStateChanged();
    }

    public void ResetForNewShow()
    {
        CurrentState = PerformanceState.Idle;
        CurrentJoke = null;
        CurrentAnalysis = null;
        JokesDisplayed = 0;
        IsShowComplete = false;
        TopJokes.Clear();
        ShowNetworkOverlay = false;
        RetryCount = 0;
        NotifyStateChanged();
    }

    public async Task RetryNetworkAsync()
    {
        IsRetrying = true;
        RetryCount++;
        NotifyStateChanged();

        try { await Task.Delay(TimeSpan.FromMilliseconds(_settings.RetryDelayMilliseconds), _cts?.Token ?? CancellationToken.None); }
        catch (OperationCanceledException) { /* ignore if cancelled during retry delay */ }

        IsRetrying = false;
        ShowNetworkOverlay = false;
        NotifyStateChanged();
    }

    private async Task RunPerformanceLoopAsync(CancellationToken cancellationToken)
    {
        JokesDisplayed = 0;
        IsShowComplete = false;
        TopJokes.Clear();

        while (!cancellationToken.IsCancellationRequested && JokesDisplayed < MaxJokesPerShow)
        {
            try
            {
                await FetchJokeAsync(cancellationToken);
                if (cancellationToken.IsCancellationRequested || CurrentJoke == null) break;

                await ShowSetupAsync(cancellationToken);
                if (cancellationToken.IsCancellationRequested) break;

                await ShowAiGuessAsync(cancellationToken);
                if (cancellationToken.IsCancellationRequested) break;
                if (CurrentAnalysis is null) continue; // content-filtered — skip to next joke

                await RevealPunchlineAsync(cancellationToken);
                if (cancellationToken.IsCancellationRequested) break;

                JokesDisplayed++;
                if (CurrentAnalysis is not null)
                {
                    TopJokes.Add(CurrentAnalysis);
                }

                if (JokesDisplayed < MaxJokesPerShow)
                {
                    await TransitionAsync(cancellationToken);
                }
            }
            catch (HttpRequestException)
            {
                await HandleNetworkErrorAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                throw; // expected during stop
            }
            catch (Exception)
            {
                try { await Task.Delay(3000, cancellationToken); }
                catch (OperationCanceledException) { throw; }
            }
        }

        if (JokesDisplayed >= MaxJokesPerShow && !cancellationToken.IsCancellationRequested)
        {
            IsShowComplete = true;
            CurrentState = PerformanceState.Complete;
            NotifyStateChanged();
        }
    }

    private async Task FetchJokeAsync(CancellationToken cancellationToken)
    {
        CurrentState = PerformanceState.Fetching;
        NotifyStateChanged();

        var safeMode = SelectedSafeMode ? "true" : "false";
        var excludeIdsQuery = SeenJokeIds.Count > 0
            ? string.Join("", SeenJokeIds.TakeLast(50).Select(id => $"&excludeIds={id}"))
            : "";

        HttpResponseMessage? response = null;
        try
        {
            response = await _http.GetAsync(
                $"/api/joker/fetch?safeMode={safeMode}&category={Uri.EscapeDataString(SelectedCategory)}{excludeIdsQuery}",
                cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                // Surface the failure so the operator sees it instead of stale state.
                // 401 = session expired (e.g. cookie cleared mid-show); 503 = upstream joke API down;
                // everything else is treated as transient.
                var code = (int)response.StatusCode;
                NetworkStatusText = code switch
                {
                    401 => "The royal seal is missing — sign in again to continue the show.",
                    403 => "Access to the jester's joke vault was denied.",
                    404 => "The jester has no joke for that category.",
                    503 => "The comedic muses are off duty (upstream joke API unreachable).",
                    _   => $"The courier returned {code}; will try again in a moment."
                };
                ShowNetworkOverlay = true;
                NotifyStateChanged();
                await Task.Delay(TimeSpan.FromMilliseconds(_settings.RetryDelayMilliseconds), cancellationToken);
                return;
            }

            CurrentJoke = await response.Content.ReadFromJsonAsync(
                ApiJsonContext.Default.JokeDto, cancellationToken);
            if (CurrentJoke is not null)
            {
                SeenJokeIds.Add(CurrentJoke.Id);
            }
        }
        catch (HttpRequestException)
        {
            // Network blip — let the catch in RunPerformanceLoopAsync surface the overlay.
            throw;
        }
        finally
        {
            response?.Dispose();
        }
    }

    private async Task ShowSetupAsync(CancellationToken cancellationToken)
    {
        CurrentState = PerformanceState.ShowingSetup;
        NotifyStateChanged();

        if (CurrentJoke is not null)
        {
            await _speechService.SpeakAsync(CurrentJoke.Setup, rate: 0.9, pitch: 1.1);
        }

        await Task.Delay(TimeSpan.FromSeconds(_settings.SetupDurationSeconds), cancellationToken);
    }

    private async Task ShowAiGuessAsync(CancellationToken cancellationToken)
    {
        CurrentState = PerformanceState.ShowingAiGuess;
        CurrentAnalysis = null;
        NotifyStateChanged();

        var drumRollTask = _audioService.PlayDrumRollAsync(2.0, 0.4);

        var request = new HttpRequestMessage(HttpMethod.Post, "/api/joker/analyze");
        request.Headers.Add("X-Session-Id", SessionId);
        request.Content = JsonContent.Create(CurrentJoke, ApiJsonContext.Default.JokeDto);
        var analysisResponse = await _http.SendAsync(request, cancellationToken);

        // Content filter (451) — skip the joke silently.
        if ((int)analysisResponse.StatusCode == 451)
            return;

        if (analysisResponse.IsSuccessStatusCode)
        {
            CurrentAnalysis = await analysisResponse.Content.ReadFromJsonAsync(
                ApiJsonContext.Default.JokeAnalysisDto, cancellationToken);
        }

        await drumRollTask;

        if (CurrentAnalysis?.AiPunchline is not null)
        {
            await _speechService.SpeakAsync($"The Jester guesses: {CurrentAnalysis.AiPunchline}", rate: 0.9, pitch: 1.0);
        }

        NotifyStateChanged();
        await Task.Delay(TimeSpan.FromSeconds(_settings.PredictionDurationSeconds), cancellationToken);
    }

    private async Task RevealPunchlineAsync(CancellationToken cancellationToken)
    {
        CurrentState = PerformanceState.RevealingPunchline;
        NotifyStateChanged();

        var isTriumph = CurrentAnalysis?.IsTriumph == true;
        if (isTriumph)
        {
            SessionTriumphs++;
            await _audioService.PlayFanfareAsync(0.5);
        }
        else
        {
            SessionDefeats++;
            await _audioService.PlayTromboneAsync(0.5);
        }

        if (CurrentJoke?.Punchline is not null)
        {
            await Task.Delay(TimeSpan.FromSeconds(_settings.PunchlineDelaySeconds), cancellationToken);
            await _speechService.SpeakAsync($"The actual punchline is: {CurrentJoke.Punchline}", rate: 0.85, pitch: 1.0);
        }

        await Task.Delay(TimeSpan.FromSeconds(_settings.PunchlineDurationSeconds), cancellationToken);
    }

    private async Task TransitionAsync(CancellationToken cancellationToken)
    {
        CurrentState = PerformanceState.Transitioning;
        NotifyStateChanged();
        await Task.Delay(TimeSpan.FromSeconds(_settings.TransitionDurationSeconds), cancellationToken);
    }

    private async Task HandleNetworkErrorAsync(CancellationToken cancellationToken)
    {
        NetworkStatusText = "The courier was lost on the road...";
        ShowNetworkOverlay = true;
        NotifyStateChanged();

        while (ShowNetworkOverlay && !cancellationToken.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromMilliseconds(_settings.UserInteractionPollMilliseconds), cancellationToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    private void NotifyStateChanged() => StateChanged?.Invoke();

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
        _cts?.Dispose();
    }
}
