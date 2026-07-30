namespace PoMiniGamesClient.Games.PoSurvive.Services;

using System.Net.Http.Json;
using Microsoft.JSInterop;
using PoMiniGamesClient.Games.PoSurvive.Store;
using PoMiniGamesClient.Services;
using PoShared.Simulation.Interfaces;
using PoShared.Simulation.Models;

/// <summary>
/// Brings PoSurvive's inference online, once per app lifetime.
///
/// Nothing used to do this. <c>LocalModelBootstrapService.InitModelAsync</c> — the call that
/// downloads the in-browser model — had no caller anywhere in the solution, and
/// <c>SurviveStore.BootReady()</c> / <c>InferenceConfigured()</c> were reachable only from the
/// Advanced drawer's model dropdown. Both were left orphaned when the "Mission Control" idle
/// screen was deleted. The consequence was silent and total: <c>Boot.IsReady</c> was false on
/// every navigation, so <c>PoSurvivePage.BootArenaAsync</c> took the degraded-mode branch,
/// which made <c>StartSimulation(isMockProvider: true)</c>, which made the orchestrator
/// short-circuit before ever touching <see cref="IInferenceService"/>. Every battle in every
/// environment ran on the orchestrator's trait-hash fallback table while the header claimed
/// an AI was thinking.
///
/// Provider choice, in order of preference:
///
/// 1. <b>Cloud relay</b> — asks <c>GET /api/infer/status</c>. Instant (no download) and the
///    cheap deployment the server picks for this game. Preferred whenever it is on.
/// 2. <b>In-browser model</b> — WebLLM in a Web Worker via the existing bridge. No key, no
///    server cost, works offline, but a multi-hundred-MB first load. The default local model
///    is deliberately the smallest one configured.
/// 3. <b>Degraded</b> — the fallback table, now reached only when both of the above fail, and
///    reported honestly instead of silently.
///
/// Nothing here blocks the arena. The page starts the battle as soon as a provider is ready
/// and falls back to degraded mode after a grace period; a local download that finishes late
/// simply upgrades the next battle.
/// </summary>
public sealed class InferenceBootstrapper : IAsyncDisposable
{
    private readonly SurviveStore _store;
    private readonly LocalModelBootstrapService _models;
    private readonly IInferenceService _inference;
    private readonly IServiceProvider _services;
    private readonly HttpClient _http;
    private readonly IJSRuntime _js;

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly TaskCompletionSource _ready =
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private DotNetObjectReference<InferenceBootstrapper>? _selfRef;
    private bool _started;

    public InferenceBootstrapper(
        SurviveStore store,
        LocalModelBootstrapService models,
        IInferenceService inference,
        IServiceProvider services,
        HttpClient http,
        IJSRuntime js)
    {
        _store = store;
        _models = models;
        _inference = inference;
        _services = services;
        _http = http;
        _js = js;
    }

    /// <summary>Resolves when a real provider is ready. Never faults.</summary>
    public Task Ready => _ready.Task;

    /// <summary>
    /// What the server said about its relay, or null if it was never reached. The model
    /// picker builds its "Cloud" group from this rather than from the WASM app's own
    /// configuration, which listed a deployment id (<c>gpt-5.4-nano</c>) the server's
    /// allowlist did not contain — so the only cloud option the UI could offer was one the
    /// relay would not serve.
    /// </summary>
    public InferenceStatusDto? CloudStatus { get; private set; }

    /// <summary>
    /// Model options that are actually usable right now: every configured in-browser model,
    /// plus the server's deployment when the relay is up.
    /// </summary>
    public List<ModelOption> AvailableModels()
    {
        var options = _models.ReadLocalModelOptions()
            .Select(l => new ModelOption(l.Id, l.Label, l.Description, IsRemote: false))
            .ToList();

        if (CloudStatus is { Available: true } cloud)
        {
            options.Add(new ModelOption(
                cloud.ModelId,
                cloud.Label,
                "Served by the host's inference relay — nothing to download.",
                IsRemote: true));
        }

        return options;
    }

    /// <summary>
    /// Switches provider from the Advanced drawer. Handles the local case properly: the
    /// drawer used to flip the router and the provider chip but never start the model
    /// download, and never called BootReady, so choosing an in-browser model left the game
    /// permanently un-ready with no indication why.
    /// </summary>
    public async Task SwitchToAsync(ModelOption option)
    {
        _store.ResetInferenceBootstrap();

        if (option.IsRemote)
        {
            if (_services.GetService<InferenceRouter>() is { } router)
                router.UseRemote(option.Id);

            _store.InferenceConfigured("REMOTE", option.Id, option.Label);
            MarkReady();
            return;
        }

        if (_inference is MockInferenceService)
        {
            _store.InferenceConfigured("MOCK", option.Id, option.Label);
            MarkReady();
            return;
        }

        if (_services.GetService<InferenceRouter>() is { } localRouter)
            localRouter.UseLocal();

        _store.InferenceConfigured("LOCAL", option.Id, option.Label);
        await InitLocalWorkerAsync(option.Id);
    }

    /// <summary>
    /// Runs the bootstrap at most once. Safe to call from both the page and the layout —
    /// whichever renders first wins and the other awaits the same result.
    /// </summary>
    public async Task EnsureStartedAsync()
    {
        await _gate.WaitAsync();
        try
        {
            if (_started) return;
            _started = true;
        }
        finally
        {
            _gate.Release();
        }

        try
        {
            await StartAsync();
        }
        catch (Exception ex)
        {
            // Never let bootstrap failure take the page down — degraded mode is a valid
            // outcome, it just has to be an announced one.
            _store.InferenceInitFailed(ex.Message);
        }
    }

    /// <summary>
    /// Waits up to <paramref name="grace"/> for a provider. Returns false on timeout, which
    /// the caller treats as "start degraded for now".
    /// </summary>
    public async Task<bool> WaitForReadyAsync(TimeSpan grace)
    {
        if (_store.Boot.IsReady) return true;

        var timeout = Task.Delay(grace);
        var winner = await Task.WhenAny(Ready, timeout);
        return winner != timeout;
    }

    private async Task StartAsync()
    {
        // Mock registration is a deployment-time decision (Inference:UseMock), not a
        // failure. Report it as MOCK rather than pretending a model is loading.
        if (_inference is MockInferenceService)
        {
            _store.GpuProbeCompleted("MOCK PROVIDER", isMockProvider: true);
            _store.InferenceConfigured("MOCK", "mock", "Scripted mock");
            MarkReady();
            return;
        }

        if (await TryUseCloudRelayAsync())
            return;

        await StartLocalModelAsync();
    }

    private async Task<bool> TryUseCloudRelayAsync()
    {
        InferenceStatusDto? status;
        try
        {
            status = await _http.GetFromJsonAsync(
                "api/infer/status", ApiJsonContext.Default.InferenceStatusDto);
        }
        catch (Exception)
        {
            // Offline, 401 before sign-in, or the route genuinely absent. Not fatal: the
            // in-browser model needs no server at all.
            return false;
        }

        CloudStatus = status;

        if (status is not { Available: true } || string.IsNullOrWhiteSpace(status.ModelId))
            return false;

        // Registered only outside mock mode — genuinely absent there, not a sentinel.
        if (_services.GetService<InferenceRouter>() is { } router)
            router.UseRemote(status.ModelId);

        _store.GpuProbeCompleted("CLOUD RELAY", isMockProvider: false);
        _store.InferenceConfigured("REMOTE", status.ModelId, status.Label);
        MarkReady();
        return true;
    }

    private async Task StartLocalModelAsync()
    {
        var options = _models.ReadLocalModelOptions();
        if (options.Count == 0)
        {
            _store.InferenceInitFailed("No in-browser model is configured.");
            return;
        }

        var modelId = _models.ResolveDefaultSelectedModelId(_store.Boot.ModelId, options);
        var chosen = options.FirstOrDefault(o => o.Id == modelId) ?? options[0];

        if (_services.GetService<InferenceRouter>() is { } router)
            router.UseLocal();

        _store.InferenceConfigured("LOCAL", chosen.Id, chosen.Label);
        await InitLocalWorkerAsync(chosen.Id);
    }

    private async Task InitLocalWorkerAsync(string modelId)
    {
        try
        {
            // The worker reports progress and completion through the [JSInvokable] callbacks
            // below, which is the contract inferenceWorkerBridge.js has always expected
            // (OnModelProgress / OnModelReady / OnModelInitError) and which nothing supplied.
            _selfRef ??= DotNetObjectReference.Create(this);
            await _models.InitModelAsync(_selfRef, modelId);
        }
        catch (Exception ex)
        {
            _store.InferenceInitFailed($"In-browser model failed to start: {ex.Message}");
        }
    }

    private void MarkReady()
    {
        _store.BootReady();
        _ready.TrySetResult();
    }

    // ── Web Worker callbacks ──────────────────────────────────────────────────

    [JSInvokable]
    public void OnModelProgress(long loaded, long total)
        => _store.ModelLoadProgress(loaded, total);

    [JSInvokable]
    public void OnModelReady() => MarkReady();

    [JSInvokable]
    public void OnModelInitError(string error)
        => _store.InferenceInitFailed(error);

    public async ValueTask DisposeAsync()
    {
        _selfRef?.Dispose();
        _selfRef = null;
        _gate.Dispose();
        // Nothing async to await, but the contract keeps the JS ref release in one place.
        await Task.CompletedTask;
    }
}
