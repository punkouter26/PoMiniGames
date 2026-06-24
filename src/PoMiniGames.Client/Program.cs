using Fluxor;
using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using Microsoft.JSInterop;
using Radzen;
using PoMiniGamesClient;
using PoMiniGamesClient.Games.PoCoupleQuiz.Services;
using PoMiniGamesClient.Games.PoFunQuiz.Services;
using PoMiniGamesClient.Games.PoRacer;
using PoMiniGamesClient.Services;
using PoSurvive.Application.Services;
using PoSurvive.Client.Services;
using PoSurvive.Shared.Interfaces;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

// The host serves both the WASM client and the API on the SAME origin (no separate
// frontend server, no CORS — see AGENT.MD), so the origin the app was served from is
// always where the API lives. Use it directly. This is correct in every scenario:
//   • dev run on :5000  -> served from :5000 -> API on :5000
//   • E2E-UI / any host on a dynamic port -> served from that port -> API on that port
//   • Production/Staging -> same origin
// A previous hardcode of http://localhost:5000 broke any host not on :5000 (including
// the dynamic-port E2E-UI Kestrel host: the SPA called :5000 and got ERR_CONNECTION_REFUSED).
// An explicit PoMiniGames:ApiBaseAddress override remains for split dev-server setups.
var apiBase = builder.Configuration["PoMiniGames:ApiBaseAddress"]
              ?? builder.Configuration["ApiBaseAddress"];
if (string.IsNullOrWhiteSpace(apiBase))
{
    apiBase = builder.HostEnvironment.BaseAddress;
}
builder.Services.AddScoped(sp => new HttpClient
{
    BaseAddress = new Uri(apiBase)
});
builder.Services.AddScoped<ApiService>();
builder.Services.AddScoped<AuthStateService>();
// §2.3: BFF-aware AuthenticationStateProvider wired into <AuthorizeRouteView>.
builder.Services.AddScoped<AuthenticationStateProvider, BffAuthenticationStateProvider>();
builder.Services.AddAuthorizationCore();
builder.Services.AddScoped<PlayerNameService>();
builder.Services.AddScoped<ToastService>();
builder.Services.AddScoped<GameStatsService>();
// Offline score resilience: durable localStorage queue + flusher behind GameResultService,
// so a failed leaderboard submit is parked and synced on reconnect rather than lost.
builder.Services.AddScoped<PendingScoreStore>();
builder.Services.AddScoped<ScoreSyncService>();
builder.Services.AddScoped<GameResultService>();
builder.Services.AddScoped<MatchHistoryService>();
builder.Services.AddScoped<PoClickHistoryService>();
builder.Services.AddScoped<PoRacerScoreApiClient>();
// Singleton — manages the shared "Watch All Demos" auto-rotation timer
// across the lifetime of the Blazor session. Fixes the timer-leak /
// hijack-navigation bug (QA finding #1 + #4).
builder.Services.AddSingleton<KioskCoordinator>();
// PoCoupleQuiz Phase 1: SignalR client wrapper for the /couplequiz/hubs/game hub.
builder.Services.AddScoped<CoupleQuizHubService>();
// PoFunQuiz Phase 2 follow-up: SignalR client wrapper for /funquiz/gamehub.
builder.Services.AddScoped<FunQuizHubService>();

// ─── PoJoker (demo-only autonomous comedy show) ──────────────────────
// Radzen powers the leaderboard DataGrid. TTS + Web-Audio effects run via JS interop
// (pojoker-speech-interop.js / pojoker-audio-interop.js). PerformanceSettings is a plain
// singleton consumed by JesterStage when it constructs the PerformanceOrchestrator.
builder.Services.AddRadzenComponents();
builder.Services.AddScoped<PoMiniGamesClient.Games.PoJoker.IJokerSpeechService,
    PoMiniGamesClient.Games.PoJoker.JokerSpeechService>();
builder.Services.AddScoped<PoMiniGamesClient.Games.PoJoker.IJokerAudioService,
    PoMiniGamesClient.Games.PoJoker.JokerAudioService>();
builder.Services.AddSingleton<PoShared.Games.PoJoker.PerformanceSettings>();

// ─── PoSurvive (agent survival simulation) ───────────────────────────
// Fluxor (Redux) state management — scans this client assembly for the
// PoSurvive feature states, reducers, and effects copied under Games/PoSurvive.
builder.Services.AddFluxor(options => options.ScanAssemblies(typeof(Program).Assembly));

// Simulation logic (runs in-browser via WASM).
builder.Services.AddSingleton<CombatService>();
builder.Services.AddSingleton<HungerService>();
builder.Services.AddSingleton<GridService>();
builder.Services.AddSingleton<NarrativeService>();
builder.Services.AddSingleton<SimulationEngine>();
// Scoped because it injects Fluxor.IDispatcher (Scoped). In WASM, Scoped == app lifetime.
builder.Services.AddScoped<SimulationOrchestrator>();

// PoSurvive client-only services.
builder.Services.AddScoped<SessionLogService>();
builder.Services.AddScoped<AudioService>();
builder.Services.AddScoped<SimulationLaunchService>();
builder.Services.AddScoped<LocalModelBootstrapService>();
builder.Services.AddScoped<DecisionInsightService>();
builder.Services.AddScoped<EvolutionClientService>();

// Inference service. "Inference:UseMock" defaults to true to avoid a multi-GB model
// download; set it false to activate the real WebLLM (local) + Azure relay (remote) router.
var useMock = builder.Configuration.GetValue("Inference:UseMock", defaultValue: true);
if (useMock)
{
    builder.Services.AddSingleton<IInferenceService, MockInferenceService>();
    // InferenceRouter is NOT registered in mock mode; PoSurvivePage uses nullable injection.
}
else
{
    var timeoutMs = builder.Configuration.GetValue("Inference:InferenceTimeoutMs", defaultValue: 15_000);
    var maxRetryAttempts = builder.Configuration.GetValue("Inference:MaxRetryAttempts", defaultValue: 2);
    var retryDelayMs = builder.Configuration.GetValue("Inference:RetryDelayMs", defaultValue: 500);
    var retryOnCancellation = builder.Configuration.GetValue("Inference:RetryOnCancellation", defaultValue: false);
    var inferenceBaseAddress = builder.HostEnvironment.BaseAddress;

    builder.Services.AddSingleton<WebLlmInferenceService>(sp => new WebLlmInferenceService(
        js: sp.GetRequiredService<IJSRuntime>(),
        inferenceTimeoutMs: timeoutMs,
        maxRetryAttempts: maxRetryAttempts,
        retryDelayMs: retryDelayMs,
        retryOnCancellation: retryOnCancellation));

    builder.Services.AddSingleton<RemoteRelayInferenceService>(
        _ => new RemoteRelayInferenceService(new HttpClient { BaseAddress = new Uri(inferenceBaseAddress) }));

    builder.Services.AddSingleton<InferenceRouter>(sp => new InferenceRouter(
        sp.GetRequiredService<WebLlmInferenceService>(),
        sp.GetRequiredService<RemoteRelayInferenceService>()));

    builder.Services.AddSingleton<IInferenceService>(sp => sp.GetRequiredService<InferenceRouter>());
}

var host = builder.Build();

// Initialize LocalStorageService with the JS runtime so all localStorage operations work
LocalStorageService.SetJSRuntime(host.Services.GetRequiredService<IJSRuntime>());

// Fluxor requires explicit store initialisation before any action is dispatched.
await host.Services.GetRequiredService<IStore>().InitializeAsync();

await host.RunAsync();
