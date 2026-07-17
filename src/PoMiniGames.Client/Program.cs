using Fluxor;
using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using Microsoft.JSInterop;
using PoMiniGamesClient;
using PoMiniGamesClient.Games.PoCoupleQuiz.Services;
using PoMiniGamesClient.Games.PoFunQuiz.Services;
using PoMiniGamesClient.Games.PoRacer;
using PoMiniGamesClient.Services;
using PoMiniGames.Application.Simulation;
using PoMiniGamesClient.Games.PoSurvive.Services;
using PoShared.Simulation.Interfaces;

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
// §Cross-origin credentials: the Blazor WASM HttpClient uses the browser's
// `fetch` underneath, which defaults to `credentials: 'omit'`. On the
// standalone-client dev setup (Blazor served from :5261, API on :5000)
// every cross-origin request therefore drops the DevCookie set by
// /api/auth/dev-login and every protected endpoint returns 401.
//
// We patch `window.fetch` once at startup (see
// wwwroot/js/crossOriginFetchPatch.js) so requests to the API origin get
// `credentials: 'include'` while every other origin stays untouched.
// The patch is idempotent. Installed via JS interop during
// WebAssemblyHostBuilder.Build() below — see the `await host.RunAsync()`
// chain after `var host = builder.Build()`.
//
// The HttpClient is built over an explicit DelegatingHandler pipeline so
// credential inclusion has a code-level guarantee (IncludeCredentialsHandler),
// not only the JS monkey-patch, and so transient GET failures get a bounded
// retry (TransientRetryHandler). Order (outer → inner):
//   TransientRetryHandler → IncludeCredentialsHandler → HttpClientHandler
// Retry is outermost so each replayed clone passes back through
// IncludeCredentialsHandler and gets the credentials mode re-applied before it
// reaches the browser transport (HttpClientHandler backs the WASM fetch shim).
builder.Services.AddScoped(sp => new HttpClient(
    new TransientRetryHandler
    {
        InnerHandler = new IncludeCredentialsHandler
        {
            InnerHandler = new HttpClientHandler()
        }
    })
{
    BaseAddress = new Uri(apiBase)
});
builder.Services.AddScoped<ApiService>();
// §Absolute API endpoints: resolved once from configuration + host env so
// SignalR and other string-URL transports can target the API host (:5000)
// even when the WASM is served standalone on :5261.
builder.Services.AddScoped<ApiEndpoints>();
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
builder.Services.AddScoped<ActivityFeedService>();
builder.Services.AddScoped<PoRacerScoreApiClient>();
// §5 Native Web Audio micro-feedback — shared across every game so the platform
// has a consistent sound vocabulary. Lazily resolves the AudioContext on first call.
builder.Services.AddScoped<UiFeedbackService>();
// Global settings (master mute, FPS badge) shared by the layout and every game.
builder.Services.AddScoped<SettingsService>();
// NetRun10 audit #6: viewport-width helper so leaderboards can render
// top-3 on mobile and top-10 on desktop without a JS-only media query.
builder.Services.AddScoped<BrowserViewport>();
// Singleton — manages the shared "Watch All Demos" auto-rotation timer
// across the lifetime of the Blazor session. Fixes the timer-leak /
// hijack-navigation bug (QA finding #1 + #4).
builder.Services.AddSingleton<KioskCoordinator>();
// PoCoupleQuiz Phase 1: SignalR client wrapper for the /couplequiz/hubs/game hub.
builder.Services.AddScoped<CoupleQuizHubService>();
// PoFunQuiz Phase 2 follow-up: SignalR client wrapper for /funquiz/gamehub.
builder.Services.AddScoped<FunQuizHubService>();

// ─── PoJoker (demo-only autonomous comedy show) ──────────────────────
// TTS + Web-Audio effects run via JS interop
// (pojoker-speech-interop.js / pojoker-audio-interop.js). PerformanceSettings is a plain
// singleton consumed by JesterStage when it constructs the PerformanceOrchestrator.
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
var useMock = !bool.TryParse(builder.Configuration["Inference:UseMock"], out var _b0) || _b0;
if (useMock)
{
    builder.Services.AddSingleton<IInferenceService, MockInferenceService>();
    // BUG FIX (audit #2): InferenceRouter is now always registered so
    // PoSurvivePage.InferenceRouterOrNull resolves cleanly in both modes.
    // In mock mode the router's children (WebLlm + RemoteRelay) are never
    // invoked because PoSurvivePage uses only IInferenceService for actual
    // infer calls and InferenceRouter for the "Use local / Use remote"
    // toggle UI. The router below constructs its OWN child instances, so no
    // separate WebLlmInferenceService / RemoteRelayInferenceService singletons
    // are registered in this branch (they were dead — nothing resolved them).
    builder.Services.AddSingleton<InferenceRouter>(_ =>
        new InferenceRouter(
            new WebLlmInferenceService(
                null!,
                inferenceTimeoutMs: 1,
                maxRetryAttempts: 0,
                retryDelayMs: 0,
                retryOnCancellation: false),
            new RemoteRelayInferenceService(new HttpClient { BaseAddress = new Uri("http://localhost:0") })));
}
else
{
    var timeoutMs = int.TryParse(builder.Configuration["Inference:InferenceTimeoutMs"], out var _i1) ? _i1 : 15_000;
    var maxRetryAttempts = int.TryParse(builder.Configuration["Inference:MaxRetryAttempts"], out var _i2) ? _i2 : 2;
    var retryDelayMs = int.TryParse(builder.Configuration["Inference:RetryDelayMs"], out var _i3) ? _i3 : 500;
    var retryOnCancellation = bool.TryParse(builder.Configuration["Inference:RetryOnCancellation"], out var _b4) && _b4;
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

// §Cross-origin credentials patch: must run before any HttpClient is used
// (i.e. before any component renders), so we install it right after Build
// but before RunAsync. Requests to `apiBase` get credentials: 'include' so
// the DevCookie set by /api/auth/dev-login round-trips on the
// standalone-client (:5261 → :5000) dev setup. Everything else — including
// MSAL's Entra calls — keeps the browser default; passing apiBase is what
// scopes it (see the module header for the sign-in outage a blanket patch
// caused). Installs nothing when the API is same-origin.
var fetchPatchModule = await host.Services.GetRequiredService<IJSRuntime>()
    .InvokeAsync<IJSObjectReference>("import", "./js/crossOriginFetchPatch.js");
await fetchPatchModule.InvokeVoidAsync("installCrossOriginCredentialsPatch", apiBase);

await host.RunAsync();
