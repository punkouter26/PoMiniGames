using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Web;
using PoMiniGames.Shared.Games.PoEcosystem;
using PoMiniGamesClient.Games.PoEcosystem.Models;
using PoMiniGamesClient.Games.PoEcosystem.Services;
using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Games.PoEcosystem;

/// <summary>
/// Hosts the engine and the HUD. All world state arrives through
/// <see cref="PoEcosystemInteropService"/> events; this component only decides what the
/// player sees. Re-renders are deliberately rationed — stats land twice a second, and the
/// 3D view is drawn by three.js, not by Blazor.
/// </summary>
public partial class PoEcosystemViewer : ComponentBase, IAsyncDisposable
{
    private const int LogCapacity = 200;
    private const int ThoughtCapacity = 60;
    private const int ChronicleEveryYears = 10;
    // Cloud thoughts spend the caller's daily AI allowance, so a session gets a fixed
    // number and then falls back to instinct templates (see thoughtBridge.js 'cloud').
    private const int CloudThoughtsPerSession = 60;

    [Parameter] public bool IsDemo { get; set; }

    [Inject] private PoEcosystemInteropService Interop { get; set; } = default!;
    [Inject] private PoEcosystemApiClient Api { get; set; } = default!;
    [Inject] private BrowserViewport Viewport { get; set; } = default!;
    [Inject] private ToastService Toasts { get; set; } = default!;
    [Inject] private AuthStateService Auth { get; set; } = default!;
    [Inject] private UiFeedbackService Feedback { get; set; } = default!;

    private static readonly (string Key, string What)[] KeyLegend =
    [
        ("WASD", "move"), ("Shift", "run"), ("Space/Ctrl", "rise/sink"), ("F", "float/walk"), ("E", "inspect"), ("C", "cinematic"), ("Tab", "dashboard"),
    ];

    private readonly List<EcoEvent> _log = new(LogCapacity);
    private readonly List<EcoThought> _thoughts = [];
    private readonly List<EcoChronicle> _chronicles = [];
    private EcoStats? _stats;
    private EcoDetail? _detail;
    private EcoLineage? _lineage;
    private EcoLlmState? _llm;
    private IReadOnlyList<EcoModel> _models = [];
    private EcoSaveInfo? _resumePrompt;
    private EcoWorldMeta[] _worlds = [];
    private EcoSharedWorld[] _gallery = [];
    private string? _banner;
    private string? _error;
    private string? _cloudMessage;
    private string _seedInput = "";
    private bool _booted;
    private bool _dashboardOpen;
    private bool _lineageOpen;
    private bool _pointerLocked;
    private bool _narrow;
    private bool _showKeys = true;
    private bool _webGpu;
    private bool _sound = true;
    private bool _directorOn;
    private string _directorCaption = "";
    private bool _pipOn;
    private bool _cloudBusy;
    private bool _chronicleBusy;
    private bool _cloudThoughts;
    private bool _visiting;                 // a gallery world: read-only, never autosaved locally
    private int _cloudThoughtsSpent;
    private int _tint = -1;
    private int _selected = -1;
    private int _lastStanding = -1;
    private int _chronicledToYear;          // the last year a saga covered (or was offered for)
    private int _chronicleOfferYear = -1;   // a decade rolled over and no saga was written yet
    private HashSet<int> _watched = [];
    private string _decreeInput = "";
    private bool _decreeBusy;
    private string? _decreeFeedback;
    private List<EcoCultureProfile> _cultures = [];

    protected override void OnInitialized()
    {
        Interop.Ready += OnReady;
        Interop.StatsReceived += OnStats;
        Interop.EventsReceived += OnEvents;
        Interop.ThoughtsReceived += OnThoughts;
        Interop.DetailReceived += OnDetail;
        Interop.LineageReceived += OnLineage;
        Interop.LlmStateReceived += OnLlmState;
        Interop.Picked += OnPicked;
        Interop.SpeedChanged += OnSpeedChanged;
        Interop.ActionRequested += OnAction;
        Interop.DirectorChanged += OnDirector;
        Interop.PipChanged += OnPip;
        Interop.EngineError += OnEngineError;
        Interop.SnapshotExported += OnSnapshotExported;
        Interop.CloudThoughtRequested += OnCloudThoughtAsync;
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
            lowEnd: _narrow,
            demo: IsDemo);
        if (!ok) _error = "The island engine could not start. Your browser may not support WebGL2.";
        _sound = await Interop.SoundEnabledAsync();
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
        _lineage = null;
        _lineageOpen = false;
        _chronicles.Clear();
        _chronicledToYear = 0;
        _chronicleOfferYear = -1;
        _ = LoadCultureAsync();
        InvokeAsync(StateHasChanged);
    }

    private void OnStats(EcoStats stats)
    {
        _stats = stats;
        _watched = stats.Watched is null ? [] : stats.Watched.Select(w => w.Handle).ToHashSet();
        if (stats.Silent) _banner = $"The island is silent — year {stats.Year}";
        else if (stats.LastStanding >= 0 && stats.LastStanding != _lastStanding)
        {
            _lastStanding = stats.LastStanding;
            _banner = $"Last species standing: {EcoSpeciesInfo.PluralOf(stats.LastStanding)} — year {stats.Year}";
        }
        else if (stats.LastStanding < 0 && !stats.Silent) _banner = null;

        // Every ten years the chronicler is offered a decade. Offered, not written: a saga is
        // a model call, and the player decides whether this decade deserves one.
        var decade = stats.Year / ChronicleEveryYears * ChronicleEveryYears;
        if (decade > 0 && decade > _chronicledToYear && _chronicleOfferYear != decade)
        {
            _chronicleOfferYear = decade;
            Toasts.Show($"Year {decade}: a decade has passed. Open the dashboard to write its chronicle.");
        }
        InvokeAsync(StateHasChanged);
    }

    private void OnEvents(IReadOnlyList<EcoEvent> events)
    {
        _log.AddRange(events);
        if (_log.Count > LogCapacity) _log.RemoveRange(0, _log.Count - LogCapacity);
        foreach (var ev in events)
        {
            // The watch-list: a bookmarked creature dying or breeding is worth a toast; the
            // tribe climbing a tier is worth one for everybody.
            if (ev.Kind == "death" && ev.Creature is { } dead && _watched.Contains(dead)) Toasts.Show(ev.Text, ToastType.Warning);
            else if (ev.Kind == "birth" && ((ev.Mother is { } m && _watched.Contains(m)) || (ev.Father is { } f && _watched.Contains(f)))) Toasts.Show(ev.Text, ToastType.Success);
            else if (ev.Kind == "tech") Toasts.Show(ev.Text, ToastType.Success);
        }
        InvokeAsync(StateHasChanged);
    }

    private void OnThoughts(IReadOnlyList<EcoThought> thoughts)
    {
        _thoughts.AddRange(thoughts);
        if (_thoughts.Count > ThoughtCapacity) _thoughts.RemoveRange(0, _thoughts.Count - ThoughtCapacity);
        InvokeAsync(StateHasChanged);
    }

    private void OnDetail(EcoDetail? detail)
    {
        _detail = detail;
        InvokeAsync(StateHasChanged);
    }

    private void OnLineage(int handle, EcoLineage? tree)
    {
        _lineage = tree;
        _lineageOpen = tree is not null;
        if (tree is null) Toasts.Show("Nothing is known about that creature's family.");
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
            case "escape":
                if (_lineageOpen) _lineageOpen = false;
                else if (_dashboardOpen) _dashboardOpen = false;
                else _detail = null;
                break;
            case "pointerLock": _pointerLocked = value == "True" || value == "true"; break;
            default: return;
        }
        InvokeAsync(StateHasChanged);
    }

    private void OnDirector(bool on, string caption)
    {
        _directorOn = on;
        _directorCaption = caption;
        InvokeAsync(StateHasChanged);
    }

    private void OnPip(bool on)
    {
        _pipOn = on;
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
    private Task ToggleSoundAsync(bool on)
    {
        _sound = on;
        return Interop.SetSoundAsync(on).AsTask();
    }
    private Task ExportTelemetryAsync() => Interop.ExportTelemetryAsync().AsTask();

    private Task ToggleDirectorAsync() => Interop.SetDirectorAsync(!_directorOn).AsTask();
    private Task TogglePipAsync() => Interop.TogglePipAsync().AsTask();

    private Task SetTintAsync(int traitIndex)
    {
        _tint = traitIndex;
        return Interop.SetTintAsync(traitIndex).AsTask();
    }

    private Task ToggleWatchAsync()
    {
        if (_detail is null) return Task.CompletedTask;
        return Interop.WatchAsync(_detail.Handle, !_detail.Watched).AsTask();
    }

    private Task UnwatchAsync(int handle) => Interop.WatchAsync(handle, false).AsTask();

    private Task RenameAsync(string name)
    {
        if (_detail is null || string.IsNullOrWhiteSpace(name)) return Task.CompletedTask;
        return Interop.RenameAsync(_detail.Handle, name.Trim()).AsTask();
    }

    private Task OpenLineageAsync(int handle) => Interop.RequestLineageAsync(handle).AsTask();

    private void CloseLineage() => _lineageOpen = false;

    /// <summary>A click on a relative or a watched creature inspects it and, when it is alive, walks the tree there.</summary>
    private async Task SelectKinAsync(int handle)
    {
        if (handle < 0) return;
        _selected = handle;
        _dashboardOpen = false;
        await Interop.SelectAsync(handle);
        await Interop.RequestLineageAsync(handle);
    }

    /// <summary>A thought-feed click selects the thinker and leaves the dashboard so the
    /// inspector popover is visible (it is suppressed while the overlay is open).</summary>
    private async Task SelectThoughtAsync(int handle)
    {
        if (handle < 0) return;
        _selected = handle;
        _dashboardOpen = false;
        await Interop.SelectAsync(handle);
    }

    private async Task ClearSelectionAsync()
    {
        _selected = -1;
        _detail = null;
        _lineageOpen = false;
        await Interop.SelectAsync(-1);
    }

    private enum CameraPreset
    {
        IslandOverview,
        AmberClan,
        CobaltClan,
        VerdantClan
    }

    private async Task SetCameraPresetAsync(CameraPreset preset)
    {
        await Feedback.CueAsync("poecosystem", "godFinger");
        switch (preset)
        {
            case CameraPreset.IslandOverview:
                await Interop.SetCameraPoseAsync(100, 110, 200, -0.85, 0);
                break;
            case CameraPreset.AmberClan:
                await Interop.SetCameraPoseAsync(50, 45, 90, -0.65, 0);
                break;
            case CameraPreset.CobaltClan:
                await Interop.SetCameraPoseAsync(140, 45, 90, -0.65, 0);
                break;
            case CameraPreset.VerdantClan:
                await Interop.SetCameraPoseAsync(100, 45, 140, -0.65, 0);
                break;
        }
    }

    private async Task FocusTribeByIdAsync(int tribeId)
    {
        var preset = tribeId switch
        {
            1 => CameraPreset.AmberClan,
            2 => CameraPreset.CobaltClan,
            3 => CameraPreset.VerdantClan,
            _ => CameraPreset.IslandOverview,
        };
        await SetCameraPresetAsync(preset);
    }

    private async Task ToggleDashboard()
    {
        _dashboardOpen = !_dashboardOpen;
        if (_dashboardOpen)
        {
            await Feedback.GlassResonateAsync();
            _ = RefreshCloudAsync(quiet: true);
        }
        else
        {
            await Feedback.FluidRippleAsync();
            _ = Interop.RequestLockAsync();
        }
    }

    private async Task TriggerShockwaveAsync()
    {
        if (_directorOn || !_pointerLocked)
        {
            await Feedback.CueAsync("poecosystem", "shockwave");
        }
    }

    private Task SetLlmAsync((bool Enabled, string? ModelId) choice)
    {
        // "cloud" is not an in-browser model: it routes each thought through the server.
        if (choice.ModelId == "cloud")
        {
            _cloudThoughts = choice.Enabled;
            return Interop.SetLlmAsync(choice.Enabled, "cloud").AsTask();
        }
        _cloudThoughts = false;
        return Interop.SetLlmAsync(choice.Enabled, choice.ModelId).AsTask();
    }

    private async Task NewWorldAsync(string? seed)
    {
        _banner = null;
        _log.Clear();
        _dashboardOpen = false;
        _visiting = false;
        await Interop.NewWorldAsync(seed ?? _seedInput);
    }

    // ── cloud saves ──────────────────────────────────────────────────────
    private async Task RefreshCloudAsync(bool quiet = false)
    {
        if (_cloudBusy) return;
        _cloudBusy = true;
        await InvokeAsync(StateHasChanged);
        var worlds = Auth.IsAuthenticated ? Api.ListWorldsAsync() : Task.FromResult(Array.Empty<EcoWorldMeta>());
        var gallery = Api.GalleryAsync();
        await Task.WhenAll(worlds, gallery);
        _worlds = worlds.Result;
        _gallery = gallery.Result;
        if (!quiet) _cloudMessage = "Cloud refreshed.";
        _cloudBusy = false;
        await InvokeAsync(StateHasChanged);
    }

    private Task SaveToCloudAsync(string slot)
    {
        if (_stats is null || _cloudBusy) return Task.CompletedTask;
        _cloudBusy = true;
        _cloudMessage = "Packing the island…";
        // The engine answers on SnapshotExported with the gzip'd bytes.
        return Interop.ExportSnapshotAsync(slot).AsTask();
    }

    private void OnSnapshotExported(string slot, byte[] bytes) => _ = UploadAsync(slot, bytes);

    private async Task UploadAsync(string slot, byte[] bytes)
    {
        try
        {
            if (_stats is null) return;
            var name = $"Year {_stats.Year} · {_stats.Alive} alive";
            var saved = await Api.SaveWorldAsync(slot, name, int.TryParse(_seedInput, out var s) ? s : 0, _stats.Year, _stats.Tick, _stats.Counts, bytes);
            _cloudMessage = saved is null ? "The cloud did not accept the save. Sign in and try again." : $"Saved to slot {slot} ({bytes.Length / 1024} KB).";
            if (saved is not null) _worlds = await Api.ListWorldsAsync();
        }
        finally
        {
            _cloudBusy = false;
            await InvokeAsync(StateHasChanged);
        }
    }

    private async Task LoadFromCloudAsync(string slot)
    {
        if (_cloudBusy) return;
        _cloudBusy = true;
        _cloudMessage = "Fetching the island…";
        await InvokeAsync(StateHasChanged);
        var bytes = await Api.LoadWorldAsync(slot);
        if (bytes is null) _cloudMessage = "That world could not be fetched.";
        else
        {
            _log.Clear();
            _dashboardOpen = false;
            _visiting = false;
            await Interop.ImportSnapshotAsync(bytes, ephemeral: false);
            _cloudMessage = null;
        }
        _cloudBusy = false;
        await InvokeAsync(StateHasChanged);
    }

    private async Task DeleteFromCloudAsync(string slot)
    {
        if (_cloudBusy) return;
        _cloudBusy = true;
        var ok = await Api.DeleteWorldAsync(slot);
        _cloudMessage = ok ? $"Slot {slot} cleared." : "Could not delete that world.";
        if (ok) _worlds = await Api.ListWorldsAsync();
        _cloudBusy = false;
        await InvokeAsync(StateHasChanged);
    }

    private async Task ShareAsync(string slot, bool isPublic)
    {
        if (_cloudBusy) return;
        _cloudBusy = true;
        var meta = await Api.ShareWorldAsync(slot, isPublic);
        _cloudMessage = meta is null ? "Sharing failed." : isPublic ? $"Shared — code {meta.ShareCode}." : "No longer public.";
        if (meta is not null) { _worlds = await Api.ListWorldsAsync(); _gallery = await Api.GalleryAsync(); }
        _cloudBusy = false;
        await InvokeAsync(StateHasChanged);
    }

    /// <summary>Boot someone else's island read-only: it runs, but never autosaves over the local world.</summary>
    private async Task VisitAsync(string code)
    {
        if (_cloudBusy) return;
        _cloudBusy = true;
        _cloudMessage = "Sailing over…";
        await InvokeAsync(StateHasChanged);
        var bytes = await Api.GalleryBytesAsync(code);
        if (bytes is null) _cloudMessage = "That island is no longer shared.";
        else
        {
            _log.Clear();
            _dashboardOpen = false;
            _visiting = true;
            await Interop.ImportSnapshotAsync(bytes, ephemeral: true);
            _cloudMessage = null;
            Toasts.Show("You are visiting a shared island. It will not be saved over yours.");
        }
        _cloudBusy = false;
        await InvokeAsync(StateHasChanged);
    }

    // ── chronicle ────────────────────────────────────────────────────────
    private async Task WriteChronicleAsync()
    {
        if (_stats is null || _chronicleBusy) return;
        _chronicleBusy = true;
        await InvokeAsync(StateHasChanged);
        var toYear = _stats.Year;
        var fromYear = _chronicledToYear;
        // The log is the last 200 events; the chronicler gets the ones inside this span.
        var lines = _log
            .Select(ev => (Year: YearOf(ev), ev.Text))
            .Where(t => t.Year >= fromYear)
            .TakeLast(80)
            .Select(t => $"Y{t.Year}: {t.Text}")
            .ToArray();
        var a = _stats.Almanac;
        var almanac = a is null ? null : $"born {string.Join('/', a.Born)}, died {string.Join('/', a.Died)}, huts built {a.HutsBuilt}, trees felled {a.TreesFelled}, oldest {a.OldestName} ({a.OldestAge:0.0} y)";
        var request = new EcoChronicleRequest(
            int.TryParse(_seedInput, out var seed) ? seed : 0, fromYear, toYear,
            _stats.Tech?.Tribe ?? "island", _stats.Counts, _stats.Extinct, lines, almanac);
        var saga = await Api.WriteChronicleAsync(request);
        if (saga is null) Toasts.Show("The chronicler is unavailable right now.", ToastType.Warning);
        else
        {
            _chronicles.Insert(0, saga);
            if (_chronicles.Count > 12) _chronicles.RemoveAt(_chronicles.Count - 1);
            _chronicledToYear = toYear;
            _chronicleOfferYear = -1;
        }
        _chronicleBusy = false;
        await InvokeAsync(StateHasChanged);
    }

    private int YearOf(EcoEvent ev) => _stats is null || _stats.Tick <= 0 ? 0 : (int)((long)ev.Tick * _stats.Year / Math.Max(1, _stats.Tick));

    // ── cloud thoughts ───────────────────────────────────────────────────
    private async Task<string?> OnCloudThoughtAsync(int handle, string system, string prompt)
    {
        if (!_cloudThoughts || _cloudThoughtsSpent >= CloudThoughtsPerSession) return null;
        _cloudThoughtsSpent++;
        var text = await Api.ThinkAsync(system, prompt);
        if (_cloudThoughtsSpent == CloudThoughtsPerSession)
        {
            Toasts.Show("Cloud thoughts for this session are used up; creatures are back on instinct.");
            _cloudThoughts = false;
            _ = Interop.SetLlmAsync(false, null);
        }
        return text;
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

    private async Task HandleDecreeKeyDownAsync(KeyboardEventArgs e)
    {
        if (e.Key == "Enter")
        {
            await SendDecreeAsync();
        }
    }

    private async Task SendDecreeAsync()
    {
        if (string.IsNullOrWhiteSpace(_decreeInput) || _decreeBusy) return;
        _decreeBusy = true;
        _decreeFeedback = null;
        StateHasChanged();

        try
        {
            var seed = int.TryParse(_seedInput, out var s) ? s : 1;
            var req = new EcoDecreeRequest(seed, _stats?.Year ?? 1, _decreeInput, null);
            var reply = await Api.InterpretDecreeAsync(req);
            if (reply is not null)
            {
                _decreeFeedback = $"{reply.DivineMessage} ({reply.Intent}: {reply.ActionType})";
                _decreeInput = "";
                Toasts.Show(reply.DivineMessage, ToastType.Success);
                await Feedback.CueAsync("poecosystem", "shockwave");
            }
            else
            {
                _decreeFeedback = "The heavens were silent.";
            }
        }
        catch
        {
            _decreeFeedback = "The decree was lost to the winds.";
        }
        finally
        {
            _decreeBusy = false;
            StateHasChanged();
        }
    }

    private async Task LoadCultureAsync()
    {
        try
        {
            var seed = int.TryParse(_seedInput, out var s) ? s : 1;
            var profiles = await Api.GetCultureAsync(seed);
            if (profiles is not null)
            {
                _cultures = [.. profiles];
            }
        }
        catch
        {
            // best-effort
        }
    }

    public async ValueTask DisposeAsync()
    {
        Interop.Ready -= OnReady;
        Interop.StatsReceived -= OnStats;
        Interop.EventsReceived -= OnEvents;
        Interop.ThoughtsReceived -= OnThoughts;
        Interop.DetailReceived -= OnDetail;
        Interop.LineageReceived -= OnLineage;
        Interop.LlmStateReceived -= OnLlmState;
        Interop.Picked -= OnPicked;
        Interop.SpeedChanged -= OnSpeedChanged;
        Interop.ActionRequested -= OnAction;
        Interop.DirectorChanged -= OnDirector;
        Interop.PipChanged -= OnPip;
        Interop.EngineError -= OnEngineError;
        Interop.SnapshotExported -= OnSnapshotExported;
        Interop.CloudThoughtRequested -= OnCloudThoughtAsync;
        await Interop.DisposeAsync();
    }
}
