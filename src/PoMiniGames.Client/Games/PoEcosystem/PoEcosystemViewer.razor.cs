using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Web;
using PoMiniGamesClient.Games.PoEcosystem.Models;
using PoMiniGamesClient.Services;

namespace PoMiniGamesClient.Games.PoEcosystem;

/// <summary>
/// Hosts the engine and the HUD. All world state arrives through
/// <see cref="PoEcosystemInteropService"/> events; this component only decides what the
/// player sees. Re-renders are deliberately rationed — stats land twice a second, and the
/// 3D view is drawn by three.js, not by Blazor.
/// </summary>
public partial class PoEcosystemViewer : ComponentBase, IAsyncDisposable
{
    private const int ToastCount = 3;
    private const int LogCapacity = 200;

    [Parameter] public bool IsDemo { get; set; }

    [Inject] private PoEcosystemInteropService Interop { get; set; } = default!;
    [Inject] private BrowserViewport Viewport { get; set; } = default!;

    private static readonly (string Key, string What)[] KeyLegend =
    [
        ("WASD", "move"), ("Shift", "run"), ("Space", "jump"), ("F", "fly"), ("E", "inspect"), ("Tab", "dashboard"),
    ];

    private readonly List<EcoEvent> _log = new(LogCapacity);
    private List<EcoEvent> _toasts = [];
    private EcoStats? _stats;
    private EcoDetail? _detail;
    private EcoLlmState? _llm;
    private IReadOnlyList<EcoModel> _models = [];
    private EcoSaveInfo? _resumePrompt;
    private string? _banner;
    private string? _error;
    private string _seedInput = "";
    private bool _booted;
    private bool _dashboardOpen;
    private bool _pointerLocked;
    private bool _narrow;
    private bool _showKeys = true;
    private bool _webGpu;
    private int _selected = -1;
    private int _lastStanding = -1;

    protected override void OnInitialized()
    {
        Interop.Ready += OnReady;
        Interop.StatsReceived += OnStats;
        Interop.EventsReceived += OnEvents;
        Interop.DetailReceived += OnDetail;
        Interop.LlmStateReceived += OnLlmState;
        Interop.Picked += OnPicked;
        Interop.SpeedChanged += OnSpeedChanged;
        Interop.ActionRequested += OnAction;
        Interop.EngineError += OnEngineError;
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (!firstRender) return;
        await Viewport.RefreshAsync();
        _narrow = Viewport.IsNarrow;

        // Three independent interop round-trips (a WebGPU adapter request, the model list,
        // and an IndexedDB probe) — run them together rather than one after another.
        // Demo mode always starts a fresh island, so it skips the resume probe.
        var webGpu = Interop.WebGpuAvailableAsync().AsTask();
        var models = Interop.ModelsAsync().AsTask();
        var probe = IsDemo ? Task.FromResult(new EcoSaveInfo(false, 0, 0, 0, 0, null)) : Interop.ProbeSaveAsync().AsTask();
        await Task.WhenAll(webGpu, models, probe);
        _webGpu = webGpu.Result;
        _models = models.Result;
        var save = probe.Result;
        if (save.Exists) _resumePrompt = save;
        else await BootAsync(resume: false);
        await InvokeAsync(StateHasChanged);
    }

    private async Task BootAsync(bool resume)
    {
        _resumePrompt = null;
        _booted = true;
        await InvokeAsync(StateHasChanged);   // the container must exist before the engine starts
        var ok = await Interop.StartAsync(
            containerId: "poeco-world",
            minimapId: "poeco-minimap",
            seed: string.IsNullOrWhiteSpace(_seedInput) ? null : _seedInput,
            resume: resume,
            llmEnabled: _webGpu && !IsDemo,
            modelId: null,
            lowEnd: _narrow);
        if (!ok) _error = "The island engine could not start. Your browser may not support WebGL2.";
        _ = HideKeysLaterAsync();
        await InvokeAsync(StateHasChanged);
    }

    private async Task HideKeysLaterAsync()
    {
        await Task.Delay(10_000);
        _showKeys = false;
        await InvokeAsync(StateHasChanged);
    }

    // ── engine callbacks ─────────────────────────────────────────────────
    private void OnReady(int seed, int tick, bool resumed, string physics)
    {
        _seedInput = seed.ToString();
        _banner = null;
        _lastStanding = -1;
        InvokeAsync(StateHasChanged);
    }

    private void OnStats(EcoStats stats)
    {
        _stats = stats;
        if (stats.Silent) _banner = $"The island is silent — year {stats.Year}";
        else if (stats.LastStanding >= 0 && stats.LastStanding != _lastStanding)
        {
            _lastStanding = stats.LastStanding;
            _banner = $"Last species standing: {EcoSpeciesInfo.PluralOf(stats.LastStanding)} — year {stats.Year}";
        }
        else if (stats.LastStanding < 0 && !stats.Silent) _banner = null;
        InvokeAsync(StateHasChanged);
    }

    private void OnEvents(IReadOnlyList<EcoEvent> events)
    {
        _log.AddRange(events);
        if (_log.Count > LogCapacity) _log.RemoveRange(0, _log.Count - LogCapacity);
        _toasts = _log.TakeLast(ToastCount).Reverse().ToList();
        InvokeAsync(StateHasChanged);
    }

    private void OnDetail(EcoDetail? detail)
    {
        _detail = detail;
        InvokeAsync(StateHasChanged);
    }

    private void OnLlmState(EcoLlmState state)
    {
        _llm = state;
        InvokeAsync(StateHasChanged);
    }

    // Named, not a lambda: the interop service outlives this component (scoped, and a WASM
    // scope is the whole app), so an unremovable handler would raise StateHasChanged on a
    // disposed component on the next visit.
    private void OnSpeedChanged(int speed) => InvokeAsync(StateHasChanged);

    private void OnPicked(int handle)
    {
        _selected = handle;
        if (handle < 0) _detail = null;
        InvokeAsync(StateHasChanged);
    }

    private void OnAction(string action, string? value)
    {
        switch (action)
        {
            case "dashboard": _dashboardOpen = !_dashboardOpen; break;
            case "escape": if (_dashboardOpen) _dashboardOpen = false; else _detail = null; break;
            case "pointerLock": _pointerLocked = value == "True" || value == "true"; break;
            default: return;
        }
        InvokeAsync(StateHasChanged);
    }

    private void OnEngineError(string where, string message)
    {
        // Physics or model failures degrade the world; they never take the page down.
        if (where is "physics" or "cannon") return;
        _error = $"{where}: {message}";
        InvokeAsync(StateHasChanged);
    }

    // ── UI actions ───────────────────────────────────────────────────────
    private Task SetSpeedAsync(int speed) => Interop.SetSpeedAsync(speed).AsTask();
    private Task InspectAsync() => Interop.SelectAsync(_selected).AsTask();
    private Task FollowAsync() => Interop.FollowAsync(_selected).AsTask();

    private async Task ClearSelectionAsync()
    {
        _selected = -1;
        _detail = null;
        await Interop.SelectAsync(-1);
    }

    private void ToggleDashboard()
    {
        _dashboardOpen = !_dashboardOpen;
        if (!_dashboardOpen) _ = Interop.RequestLockAsync();
    }

    private Task SetLlmAsync((bool Enabled, string? ModelId) choice) => Interop.SetLlmAsync(choice.Enabled, choice.ModelId).AsTask();

    private async Task NewWorldAsync(string? seed)
    {
        _banner = null;
        _log.Clear();
        _toasts = [];
        _dashboardOpen = false;
        await Interop.NewWorldAsync(seed ?? _seedInput);
    }

    // ── touch move pad ───────────────────────────────────────────────────
    private double _padX, _padY;

    private void TouchStart(TouchEventArgs e)
    {
        if (e.Touches.Length == 0) return;
        _padX = e.Touches[0].ClientX;
        _padY = e.Touches[0].ClientY;
    }

    private async Task TouchMove(TouchEventArgs e)
    {
        if (e.Touches.Length == 0) return;
        var dx = e.Touches[0].ClientX - _padX;
        var dy = e.Touches[0].ClientY - _padY;
        var len = Math.Max(1, Math.Sqrt(dx * dx + dy * dy));
        var scale = Math.Min(1, len / 60);
        await Interop.TouchMoveAsync(dx / len * scale, -dy / len * scale);
    }

    private Task TouchEnd(TouchEventArgs e) => Interop.TouchReleaseAsync().AsTask();

    // The counts come from a saved world, so a snapshot written by another schema could
    // carry a shorter array — checking the length keeps the resume prompt from throwing.
    private static string Counts(int[]? counts) =>
        counts is not { Length: EcoSpeciesInfo.Count } c ? "an empty island"
        : string.Join(", ", Enumerable.Range(0, EcoSpeciesInfo.Count).Select(s => $"{c[s]} {EcoSpeciesInfo.PluralOf(s).ToLowerInvariant()}"));

    private static string Ago(long savedAtMs)
    {
        var span = DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeMilliseconds(savedAtMs);
        return span.TotalMinutes < 1 ? "moments ago"
            : span.TotalHours < 1 ? $"{(int)span.TotalMinutes} min ago"
            : span.TotalDays < 1 ? $"{(int)span.TotalHours} h ago"
            : $"{(int)span.TotalDays} d ago";
    }

    public async ValueTask DisposeAsync()
    {
        Interop.Ready -= OnReady;
        Interop.StatsReceived -= OnStats;
        Interop.EventsReceived -= OnEvents;
        Interop.DetailReceived -= OnDetail;
        Interop.LlmStateReceived -= OnLlmState;
        Interop.Picked -= OnPicked;
        Interop.SpeedChanged -= OnSpeedChanged;
        Interop.ActionRequested -= OnAction;
        Interop.EngineError -= OnEngineError;
        await Interop.DisposeAsync();
    }
}
