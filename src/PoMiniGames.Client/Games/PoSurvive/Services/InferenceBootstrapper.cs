namespace PoMiniGamesClient.Games.PoSurvive.Services;

using System.Net.Http.Json;
using Microsoft.JSInterop;
using PoMiniGamesClient.Games.PoSurvive.Store;
using PoMiniGamesClient.Services;
using PoMiniGames.Shared.Simulation.Interfaces;
using PoMiniGames.Shared.Simulation.Models;

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
    private bool _kioskProfile;

    /// <summary>
    /// Id of the scripted option. Never sent to a relay and never handed to WebLLM — the
    /// picker and <see cref="SwitchToAsync"/> both branch on <see cref="ModelOption.IsScripted"/>
    /// before the id is ever used as one.
    /// </summary>
    public const string ScriptedModelId = "scripted";

    private const string ScriptedLabel = "Scripted (no AI)";

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
    /// Model options that are actually usable right now: every Azure deployment the relay will
    /// serve, every configured in-browser model, and the scripted stand-in.
    ///
    /// The cloud half comes from <see cref="InferenceStatusDto.Models"/> — the server's own
    /// allowlist — rather than from anything the WASM app configures. That direction is the whole
    /// point of the status endpoint: a client-side list is how the picker once ended up offering a
    /// single id the relay refused to serve. When the server reports no allowlist we still offer
    /// its default deployment, which is the id a request naming nothing is served by.
    /// </summary>
    public List<ModelOption> AvailableModels()
    {
        var options = new List<ModelOption>();

        if (CloudStatus is { Available: true } cloud)
        {
            var remote = cloud.Models is { Count: > 0 }
                ? cloud.Models
                : [new InferenceModelDto(cloud.ModelId, cloud.Label)];

            options.AddRange(remote.Select(m => new ModelOption(
                m.Id,
                m.Label,
                "Azure AI Foundry, via the host's relay — nothing to download.",
                IsRemote: true)));
        }

        options.AddRange(_models.ReadLocalModelOptions()
            .Select(l => new ModelOption(l.Id, l.Label, l.Description, IsRemote: false)));

        options.Add(new ModelOption(
            ScriptedModelId,
            ScriptedLabel,
            "Deterministic scripted tactics. Instant, offline, and costs nothing.",
            IsRemote: false,
            IsScripted: true));

        return options;
    }

    /// <summary>
    /// Boot without ever starting a model download: probe the relay so the picker knows what is
    /// on offer, then settle on the scripted provider and let the player upgrade from the bar.
    ///
    /// The kiosk reel needs this. The layout calls <see cref="EnsureStartedAsync"/> on every
    /// route including <c>/posurvive/demo</c>, so an attract screen with no relay would quietly
    /// begin pulling a multi-hundred-MB model from a CDN — the exact cost the demo's scripted
    /// default exists to avoid. Must be called before the first <see cref="EnsureStartedAsync"/>;
    /// the demo page sets it in <c>OnInitialized</c>, which precedes every render.
    /// </summary>
    public void UseKioskProfile() => _kioskProfile = true;

    /// <summary>
    /// Switches provider from the Advanced drawer. Handles the local case properly: the
    /// drawer used to flip the router and the provider chip but never start the model
    /// download, and never called BootReady, so choosing an in-browser model left the game
    /// permanently un-ready with no indication why.
    /// </summary>
    public async Task SwitchToAsync(ModelOption option)
    {
        _store.ResetInferenceBootstrap();

        // Scripted is a destination, not a failure — and in a mock build (Inference:UseMock)
        // it is the only destination there is, whichever row the player clicked. Saying so
        // beats labelling the session REMOTE and never calling a relay.
        if (option.IsScripted || _inference is MockInferenceService)
        {
            _store.ScriptedProviderSelected(
                option.IsScripted ? ScriptedModelId : option.Id,
                option.IsScripted ? ScriptedLabel : $"{option.Label} · scripted stand-in");
            MarkReady();
            return;
        }

        if (option.IsRemote)
        {
            if (_services.GetService<InferenceRouter>() is { } router)
                router.UseRemote(option.Id);

            _store.InferenceConfigured("REMOTE", option.Id, option.Label);
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
            _store.ScriptedProviderSelected(ScriptedModelId, ScriptedLabel);
            MarkReady();
            return;
        }

        // Kiosk: probe so the picker is populated, then stop. No relay activation and no
        // download — the reel starts scripted and the player opts into a model from the bar.
        if (_kioskProfile)
        {
            await ProbeCloudStatusAsync();
            _store.GpuProbeCompleted("SCRIPTED", isMockProvider: true);
            _store.ScriptedProviderSelected(ScriptedModelId, ScriptedLabel);
            MarkReady();
            return;
        }

        if (await TryUseCloudRelayAsync())
            return;

        await StartLocalModelAsync();
    }

    /// <summary>
    /// Asks the server about its relay and records the answer in <see cref="CloudStatus"/>.
    /// Never throws and never activates anything — offline, a 401 before sign-in, or a missing
    /// route all read as "no cloud", which the in-browser model does not need anyway.
    /// </summary>
    private async Task<InferenceStatusDto?> ProbeCloudStatusAsync()
    {
        try
        {
            CloudStatus = await _http.GetFromJsonAsync(
                "api/infer/status", ApiJsonContext.Default.InferenceStatusDto);
        }
        catch (Exception)
        {
            CloudStatus = null;
        }

        return CloudStatus;
    }

    private async Task<bool> TryUseCloudRelayAsync()
    {
        var status = await ProbeCloudStatusAsync();

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
