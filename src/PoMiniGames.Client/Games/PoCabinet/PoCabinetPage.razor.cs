using System.Text.Json;
using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Games.PoCabinet;

/// <summary>
/// Code-behind for <see cref="PoCabinetPage"/>. The page lifecycle is:
/// <list type="number">
///   <item><b>Start</b> — track + paint-shop selectors. <c>StartRaceAsync</c>
///         routes 1p/2p/demo straight to <see cref="Phase.Loading"/> and opens
///         a JS-only practice race; multiplayer falls through to the lobby.</item>
///   <item><b>Lobby</b> — server-managed multiplayer (T6 plumbing lives in
///         <c>PoCabinetSession</c>). The server emits <c>RaceStarting</c>;
///         we tear down the lobby and jump to <b>Loading</b>.</item>
///   <item><b>Loading → Racing</b> — JS interop loads the engine, mounts the
///         scene, and the session attaches a per-snapshot handler that pumps
///         car state into the renderer.</item>
///   <item><b>Finished</b> — server <c>RaceFinished</c> → swap to results.</item>
/// </list>
/// <para>
/// Per-tick input is captured in JS (keydown/keyup under the canvas) and
/// forwarded into <see cref="PoCabinetSession.SendInputAsync"/>. Inputs are
/// coalesced inside the session so a tight stream at 60 Hz does not flood the
/// hub.
/// </para>
/// </summary>
public partial class PoCabinetPageBase : ComponentBase, IAsyncDisposable
{
    [Inject] private IJSRuntime JS { get; set; } = default!;
    [Inject] private PlayerNameService PlayerNameSvc { get; set; } = default!;
    [Inject] private NavigationManager Nav { get; set; } = default!;
    [Inject] private GameResultService GameResults { get; set; } = default!;
    [Inject] private PoCabinetSession Session { get; set; } = default!;
    [Inject] private PoCabinetCareerState Career { get; set; } = default!;
    [Inject] private PoMiniGamesClient.Services.Auth.AuthStateService AuthState { get; set; } = default!;

    [Parameter] public string? ModeSegment { get; set; }

    protected enum Phase { Start, Lobby, Loading, Racing, Finished }

    protected GameMode Mode => GameModes.Parse(ModeSegment);

    protected string _playerName = "Player";
    protected Phase _phase = Phase.Start;
    protected string? _trackId = PoCabinetCatalog.DefaultTrackId;
    protected string? _livery = "Stripe";
    protected string? _color = "Indigo";
    protected string? _joinCode = null;

    protected int _lap = 1;
    protected int _position = 1;
    protected int _totalLaps = PoCabinetCatalog.TotalLaps;
    protected int _totalCars = 4;
    protected double _speedKmh = 0;
    protected double _lapSeconds = 0;
    protected string? _announcement = null;
    protected string? _status = null;

    // ── UX pass (2026-09-17): settings, audio, minimap, environment, sectors ──
    // JS owns the on-disk format (settings.js); this is the Blazor view model.
    protected PoCabinetUiSettings Settings { get; } = new();

    protected bool _paused;
    protected int? _pingMs;
    protected int _countdownDisplay;
    protected bool _showGo;
    protected List<PoCabinetCarState>? _finalStandings;
    protected bool _isPersonalBest;
    protected double _previousBest = -1;

    /// <summary>Sector splits of the lap currently in progress (index 2 filled when the lap closes).</summary>
    protected double?[] _sectorTimes = new double?[3];
    /// <summary>Sector splits of the most recently completed lap — rendered in the results table.</summary>
    protected double?[] _lastLapSectorTimes = new double?[3];
    protected readonly double[] _sessionBestSectors = [double.MaxValue, double.MaxValue, double.MaxValue];
    protected readonly double[] _storedBestSectors = [double.MaxValue, double.MaxValue, double.MaxValue];
    protected double _storedBestLap;
    protected List<double> _lapTimes = new();
    protected double _lastLapSeconds;
    protected double _bestLapSession;
    protected int _sectorIndex;
    protected double _sectorStart;
    /// <summary>True once the first lap line crossing aligned sector thirds to the lap.</summary>
    private bool _lineAligned;
    private double _prevProgress;
    private int _lastCountdown = -1;
    private double _goUntilElapsed;
    private string _envKey = "auto|auto";

    /// <summary>The most recent snapshot, shared with markup for live sector timing.</summary>
    protected PoCabinetRaceSnapshot? _lastSnapshot;

    /// <summary>Solo races (1p / 2p hot-seat / demo) may pause; the server owns multiplayer time.</summary>
    protected bool Pausable => !IsMultiplayerMode && _phase == Phase.Racing;

    /// <summary>Ping badge color bucket — green under 90 ms, amber under 220 ms, red beyond.</summary>
    protected string PingClass => (_pingMs ?? 999) switch
    {
        < 90 => "pocabinet-ping--good",
        < 220 => "pocabinet-ping--fair",
        _ => "pocabinet-ping--poor",
    };

    /// <summary>Fixed confetti palette; index-deterministic so re-renders don't reshuffle.</summary>
    protected static string ConfettiColor(int i) => (i % 5) switch
    {
        0 => "#c6a35a",
        1 => "#3470d8",
        2 => "#2ecc71",
        3 => "#c1253b",
        _ => "#ffffff",
    };

    /// <summary>Unitless horizontal start position (CSS converts via calc * 1%).</summary>
    protected static int ConfettiX(int i) => i * 41 % 100;

    /// <summary>Staggered fall duration so the burst looks irregular, not metronomic.</summary>
    protected static string ConfettiDelay(int i) =>
        (1.8 + i % 5 * 0.45).ToString("F2", System.Globalization.CultureInfo.InvariantCulture) + "s";

    protected RenderFragment TitleContent => builder => builder.AddMarkupContent(0, "🏛️ Cabinet");

    /// <summary>T13 UX: only show the destructive "Reset career" button after the
    /// player has actually advanced — no point poking the player with a button
    /// whose only effect is to wipe a fresh-state career.</summary>
    protected bool HasAnyCareerProgress =>
        Career.Current.CompletedStages.Count > 0
        || Career.Current.TrophyUnlocked
        || Career.Current.GoldLiveryUnlocked;

    private IJSObjectReference? _sceneHandle;
    private IJSObjectReference? _cockpitHandle;
    private readonly Dictionary<int, IJSObjectReference> _carHandles = new();
    private IJSObjectReference? _dialogueHandle;
    private IJSObjectReference? _minimapHandle;
    private IJSObjectReference? _envHandle;
    private string? _currentDialogueOfficialId;
    /// <summary>DOM handle for the racing canvas. Filled by Blazor's @ref binding
    /// after the Racing-section render — the JS <c>mount(canvas, …)</c> call needs
    /// an actual HTMLCanvasElement, not the id string (three.js's WebGLRenderer
    /// calls setAttribute/innerWidth on it; passing a string throws).</summary>
    protected ElementReference _canvas;
    /// <summary>Decorative minimap overlay; aria-hidden, so no focusable semantics.</summary>
    protected ElementReference _minimapCanvas;
    private DotNetObjectReference<PoCabinetPageBase>? _selfRef;
    private string? _gameCode;
    private bool _wiredSessionHandlers;
    /// <summary>Guards the Loading-phase mount against re-entrant renders.</summary>
    private bool _mountStarted;
    // T11: track previous lap and lap-start time so we can derive a best-lap
    // running tally from snapshot differences. Reset per-race (called by
    // BeginSoloAsync / BeginWireModeAsync).
    private int _lastLapCount;
    private double _lastLapTime;

    protected override async Task OnInitializedAsync()
    {
        await Career.LoadAsync();
        _selfRef = DotNetObjectReference.Create(this);

        // Player prefs live in a JS-owned localStorage store (settings.js).
        // Loading here also warms the JS-side copy the environment/minimap
        // modules read directly. Defaults hold when storage is unavailable.
        try
        {
            var el = await JS.InvokeAsync<JsonElement>("PoCabinet.loadSettings");
            Settings.LoadFrom(el);
            _envKey = $"{Settings.Weather}|{Settings.TimeOfDay}";
        }
        catch { /* interop not ready (prerender) — defaults are fine */ }

        // If the URL carries a code query string, the player arrived from the
        // lobby and we're in wire-mode multiplayer — start the race hub
        // connection immediately. Solo paths don't carry a code, so they fall
        // through to the normal "click Start → BeginSoloAsync" path.
        var uri = Nav.ToAbsoluteUri(Nav.Uri);
        var query = uri.Query.TrimStart('?');
        foreach (var kvp in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = kvp.IndexOf('=');
            if (eq <= 0) continue;
            var key = kvp[..eq];
            var value = kvp[(eq + 1)..];
            if (string.Equals(key, "code", StringComparison.OrdinalIgnoreCase))
            {
                var code = Uri.UnescapeDataString(value);
                // Defer until after first render — the page must be ready to
                // call EnsureEngineAsync (DOM-bound interop).
                _ = InvokeAsync(async () =>
                {
                    await Task.Yield();
                    await BeginWireModeAsync(code);
                });
                return;
            }
        }
    }

    /// <summary>
    /// Demo mode auto-starts on first paint (matched to the kiosk-reel
    /// posture — going to /pocabinet/demo is itself the "play" intent). Every
    /// mode funnels through the same two-render dance:
    /// <list type="number">
    ///   <item>the <b>Loading</b> phase renders the Racing section, which adds
    ///         the canvas to the DOM;</item>
    ///   <item>the next render cycle fires this hook again with
    ///         <c>_phase == Loading</c> and a live canvas — only then do we
    ///         mount the engine. Mounting earlier hands three.js a missing
    ///         element (the solo Start button used to die silently here).</item>
    /// </list>
    /// </summary>
    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (Mode == GameMode.Demo && firstRender && _phase == Phase.Start)
        {
            _playerName = PlayerNameSvc.GetOrReadInitialName();
            _phase = Phase.Loading;
            await InvokeAsync(StateHasChanged);
            return;
        }

        if (_phase == Phase.Loading && !_mountStarted)
        {
            _mountStarted = true;
            try
            {
                if (IsMultiplayerMode && _gameCode is not null)
                    await JoinWireRaceAsync(_gameCode);
                else
                    await BeginSoloAsync();
            }
            finally
            {
                _mountStarted = false;
            }
        }
    }

    protected Task OnTrackChanged(string trackId)
    {
        _trackId = trackId;
        return Task.CompletedTask;
    }

    protected Task OnPaintChanged((string Livery, string Color) sel)
    {
        _livery = sel.Livery;
        _color = sel.Color;
        return Task.CompletedTask;
    }

    /// <summary>
    /// Whether the current mode goes through the server race hub (multiplayer
    /// does) or runs entirely in the browser (1p/2p/demo). The two paths share
    /// the same cockpit render — only the snapshot source differs.
    /// </summary>
    protected bool IsMultiplayerMode => Mode == GameMode.Multiplayer;

    /// <summary>Entry point — decides between lobby (multiplayer) and race (1p/2p/demo).
    /// Solo paths flip to Loading; <see cref="OnAfterRenderAsync"/> performs the
    /// actual mount once the canvas is in the DOM.</summary>
    protected async Task StartRaceAsync()
    {
        _playerName = PlayerNameSvc.GetOrReadInitialName();
        // Web Audio needs a user gesture to unlock the context — this click is it.
        try
        {
            await JS.InvokeVoidAsync("PoCabinet.initAudio");
            await JS.InvokeVoidAsync("PoCabinet.setAudioSuspended", false);
        }
        catch { /* audio is a bonus, never a gate */ }
        if (Mode == GameMode.Multiplayer)
        {
            _phase = Phase.Lobby;
            await InvokeAsync(StateHasChanged);
            return;
        }
        _phase = Phase.Loading;
        await InvokeAsync(StateHasChanged);
    }

    /// <summary>
    /// T13 (2026-09-17): reset the local career state. Wired to a "Reset
    /// career" button on the start panel; <see cref="PoCabinetCareerState.Changed"/>
    /// triggers the championship view to re-render.
    /// </summary>
    protected async Task ResetCareerAsync()
    {
        await Career.ResetAsync();
    }

    /// <summary>Mount the scene and start a JS-side single-player race tick.</summary>
    private async Task BeginSoloAsync()
    {
        try
        {
            var trackId = _trackId ?? PoCabinetCatalog.DefaultTrackId;
            ResetTelemetry();
            await LoadStoredRecordsAsync(trackId);
            await EnsureEngineAsync();
            await MountSceneAsync(trackId);
            _status = null;
            _phase = Phase.Racing;
            await InvokeAsync(StateHasChanged);
            // Fan keyboard + snapshot callbacks into the page through a single
            // DotNetObjectReference so the JS ticker doesn't need to know
            // which Blazor method to call. The self-ref is created in
            // OnInitializedAsync. MountSceneAsync has already resolved the
            // environment, so the ticker sees the rain-grip factor in time.
            await JS.InvokeVoidAsync("PoCabinet.startSoloRace", _selfRef, _playerName, _livery, _color);
        }
        catch (Exception ex)
        {
            // The status paragraph lives in the race section, so a Start-phase
            // fallback would swallow it — mirror the failure to the console too.
            try { await JS.InvokeVoidAsync("console.error", "pocabinet BeginSoloAsync failed: " + ex); } catch { }
            _status = $"Could not start the race: {ex.Message}";
            _phase = Phase.Start;
            await InvokeAsync(StateHasChanged);
        }
    }

    /// <summary>
    /// Wire-mode race entry point. Called from the lobby's <c>RaceStarting</c>
    /// handoff (PoCabinetLobby navigates here with a query-string game code).
    /// Only records state — the hub join + scene mount wait for the Loading
    /// render inside <see cref="OnAfterRenderAsync"/>, when the canvas exists.
    /// </summary>
    public Task BeginWireModeAsync(string gameCode)
    {
        _gameCode = gameCode;
        _phase = Phase.Loading;
        _status = null;
        return InvokeAsync(StateHasChanged);
    }

    /// <summary>
    /// Join the server race: wire handlers, hub join, ping loop, then Racing.
    /// Runs from <see cref="OnAfterRenderAsync"/> with the canvas mounted.
    /// </summary>
    private async Task JoinWireRaceAsync(string gameCode)
    {
        try
        {
            ResetTelemetry();
            await LoadStoredRecordsAsync(_trackId ?? PoCabinetCatalog.DefaultTrackId);
            await EnsureEngineAsync();
            await MountSceneAsync(_trackId ?? PoCabinetCatalog.DefaultTrackId);
            // Subscribe snapshot/finished to our local handlers. We do this
            // BEFORE JoinRace so the initial response is captured.
            WireSessionHandlers();
            await Session.JoinRaceAsync(gameCode);
            Session.StartPingLoop();
            _phase = Phase.Racing;
            await InvokeAsync(StateHasChanged);
        }
        catch (Exception ex)
        {
            try { await JS.InvokeVoidAsync("console.error", "pocabinet JoinWireRaceAsync failed: " + ex); } catch { }
            _status = $"Could not join the race: {ex.Message}";
            _phase = Phase.Lobby;
            await InvokeAsync(StateHasChanged);
        }
    }

    private void WireSessionHandlers()
    {
        // Idempotent: re-binding on a phase flip would just double-fire.
        if (_wiredSessionHandlers) return;
        _wiredSessionHandlers = true;
        Session.SnapshotReceived += OnWireSnapshotAsync;
        Session.RaceFinished += OnWireRaceFinishedAsync;
        Session.RaceStarting += OnWireRaceStartingAsync;
        Session.StatusChanged += msg => { _status = msg; return InvokeAsync(StateHasChanged); };
        Session.PingMeasured += ms =>
        {
            _pingMs = (int)Math.Round(ms);
            return InvokeAsync(StateHasChanged);
        };
    }

    private Task OnWireSnapshotAsync(PoCabinetRaceSnapshot snap)
    {
        ApplySnapshot(snap);
        return Task.CompletedTask;
    }

    private async Task OnWireRaceFinishedAsync(string gameCode)
    {
        _phase = Phase.Finished;
        await InvokeAsync(StateHasChanged);
    }

    private Task OnWireRaceStartingAsync(string trackId)
    {
        // Server may resend RaceStarting in wire-mode (e.g. on reconnect).
        // Treat as a hint to reflect the agreed track, not navigation.
        _trackId = trackId;
        return Task.CompletedTask;
    }

    private async Task EnsureEngineAsync()
    {
        var ready = await JS.InvokeAsync<bool>("loadEngine", "pocabinet");
        if (!ready) throw new InvalidOperationException("pocabinet engine failed to load");
    }

    /// <summary>
    /// Mount the three.js scene, the cockpit, the dialogue bubble and place
    /// the local car. Bots are added once the first snapshot arrives. The UX
    /// pass also mounts the minimap overlay and the environment layer
    /// (night/rain); environment resolution happens BEFORE the solo ticker
    /// starts so its rain-grip factor is in place for the first tick.
    /// </summary>
    private async Task MountSceneAsync(string trackId)
    {
        // The server-side TrackRegistry is the source of truth for centerlines
        // and atmosphere; the client just needs the same values for solo races
        // so the cockpit renders against the same backdrop. Build a per-track
        // (atmosphere, centerline) pair inline — see PoCabinetTrackData for the
        // matching server definitions.
        var (atmosphere, centerline) = PoCabinetScenePresets.ForTrack(trackId);
        // IJSRuntime does not marshal ElementReference as a live DOM element —
        // three.js's WebGLRenderer needs addEventListener — so mounts resolve
        // the canvases by id inside JS instead.
        _sceneHandle = await JS.InvokeAsync<IJSObjectReference>("PoCabinet.mount",
            "pocabinetCanvas", atmosphere, centerline);
        _cockpitHandle = await JS.InvokeAsync<IJSObjectReference>("PoCabinet.mountCockpit", _sceneHandle);
        // dialogue.js appends a DOM bubble — it needs an element, not the scene.
        _dialogueHandle = await JS.InvokeAsync<IJSObjectReference>("PoCabinet.mountDialogue",
            "pocabinetDialogueLayer", "sean-s");
        _currentDialogueOfficialId = "sean-s";

        // Push persisted prefs into the live view (pixel ratio + FOV + audio).
        try { await JS.InvokeVoidAsync("PoCabinet.applySettings", _sceneHandle, Settings.ToJs()); }
        catch { /* settings are cosmetic */ }

        // Minimap overlay (decorative; failures never block the race).
        try
        {
            _minimapHandle = await JS.InvokeAsync<IJSObjectReference>("PoCabinet.mountMinimap",
                "pocabinetMinimap", centerline, new { accent = AccentFor(trackId), colorSafe = Settings.ColorSafe });
        }
        catch { _minimapHandle = null; }

        // Environment layer: resolves time-of-day + weather ("auto" = local
        // clock + a cached Washington D.C. open-meteo lookup) and applies
        // night lighting / rain streaks. Failure degrades to the base scene.
        try { _envHandle = await JS.InvokeAsync<IJSObjectReference>("PoCabinet.mountEnvironment", _sceneHandle); }
        catch { _envHandle = null; }
    }

    /// <summary>
    /// Called by JS solo-race loop on every snapshot. We mirror the snapshot
    /// shape with the rest of the multiplayer world so the engine updates the
    /// local car; bots are created lazily on their first sighting.
    /// </summary>
    [JSInvokable]
    public async Task OnSoloSnapshotAsync(PoCabinetRaceSnapshot snap)
    {
        ApplySnapshot(snap);
        await Task.CompletedTask;
    }

    private void ApplySnapshot(PoCabinetRaceSnapshot snap)
    {
        _lastSnapshot = snap;
        // Lazy-mount opponents + dialogue on first sight, then update them.
        foreach (var car in snap.Cars ?? Array.Empty<PoCabinetCarState>())
        {
            if (car.IsPlayer) continue;
            if (!_carHandles.ContainsKey(car.Id))
            {
                // Mount opponent lazily; ignore failure on a race that ended.
                try
                {
                    var handle = JS.InvokeAsync<IJSObjectReference>("PoCabinet.mountCar", _sceneHandle, new
                    {
                        officialId = car.OfficialId,
                        color = car.Color,
                        colorDark = car.ColorDark,
                    }).GetAwaiter().GetResult();
                    _carHandles[car.Id] = handle;
                }
                catch
                {
                    // Engine was torn down mid-render; let the next snapshot or
                    // dispose clear state.
                }
            }
            if (_carHandles.TryGetValue(car.Id, out var carHandle))
            {
                try { JS.InvokeVoidAsync("PoCabinet.updateCar", carHandle, car).GetAwaiter().GetResult(); }
                catch { /* swallow — race race-over path will dispose */ }
            }
        }

        // Countdown beeps (both solo and wire races — the snapshot carries the
        // value in both paths). Transition 1 → 0 raises the higher GO ping and
        // flashes "GO!" for about a second of race time.
        if (snap.CountdownSeconds != _lastCountdown)
        {
            var previous = _lastCountdown;
            _lastCountdown = snap.CountdownSeconds;
            if (snap.CountdownSeconds > 0)
            {
                _countdownDisplay = snap.CountdownSeconds;
                try { JS.InvokeVoidAsync("PoCabinet.countdownBeep", false).GetAwaiter().GetResult(); } catch { }
            }
            else if (previous > 0)
            {
                _countdownDisplay = 0;
                _goUntilElapsed = snap.ElapsedRaceTime + 1.2;
                try { JS.InvokeVoidAsync("PoCabinet.countdownBeep", true).GetAwaiter().GetResult(); } catch { }
            }
        }
        _showGo = _goUntilElapsed > 0 && snap.ElapsedRaceTime <= _goUntilElapsed;

        var localCar = (snap.Cars ?? Array.Empty<PoCabinetCarState>()).FirstOrDefault(c => c.IsPlayer);
        if (localCar is not null)
        {
            _speedKmh = localCar.SpeedKmh;
            // Cockpit camera rides the player's car (position + heading).
            if (_sceneHandle is not null)
            {
                try { JS.InvokeVoidAsync("PoCabinet.updatePlayerView", _sceneHandle, new { x = localCar.X, y = localCar.Y, heading = localCar.Heading }).GetAwaiter().GetResult(); } catch { }
            }
            // Engine hum follows the player's speed; squeal is armed by the
            // input handler when steering hard at pace.
            try { JS.InvokeVoidAsync("PoCabinet.updateEngineAudio", snap.Started && !snap.Finished ? localCar.SpeedKmh : 0).GetAwaiter().GetResult(); } catch { }
            // Minimap: the overlay is decorative, so a failed frame is skipped.
            if (_minimapHandle is not null)
            {
                try { JS.InvokeVoidAsync("PoCabinet.updateMinimap", _minimapHandle, snap.Cars).GetAwaiter().GetResult(); } catch { }
            }
            // T11: detect a lap completion (lap count rises) and use the time
            // since the previous lap to maintain a "best lap" running tally.
            // When the solo ticker reports its own bestLapSeconds it wins
            // (overrides via && below). This keeps wire-mode multiplayer
            // playable even though the server doesn't compute per-car laps yet.
            if (_lastLapCount > 0 && localCar.Lap > _lastLapCount)
            {
                var lapTime = snap.ElapsedRaceTime - _lastLapTime;
                if (lapTime > 0 && (snap.BestLapSeconds is null || lapTime < snap.BestLapSeconds))
                {
                    snap = new PoCabinetRaceSnapshot
                    {
                        GameCode = snap.GameCode,
                        ServerTimeMs = snap.ServerTimeMs,
                        ElapsedRaceTime = snap.ElapsedRaceTime,
                        Started = snap.Started,
                        CountdownSeconds = snap.CountdownSeconds,
                        Finished = snap.Finished,
                        LocalCarId = snap.LocalCarId,
                        Cars = snap.Cars ?? new List<PoCabinetCarState>(),
                        LatestDialogue = snap.LatestDialogue,
                        Static = snap.Static,
                        BestLapSeconds = lapTime,
                    };
                }
                CloseLapTelemetry(lapTime, snap.ElapsedRaceTime);
                if (lapTime > 0)
                {
                    try { JS.InvokeVoidAsync("PoCabinet.lapChime").GetAwaiter().GetResult(); } catch { }
                }
            }
            _lastLapCount = localCar.Lap;
            _lap = localCar.Lap;
            _position = localCar.Position;
            _totalCars = snap.Cars?.Count ?? _totalCars;
            _lapSeconds = snap.ElapsedRaceTime;
            if (snap.BestLapSeconds is { } reported && reported > 0 &&
                (_bestLapSession <= 0 || reported < _bestLapSession))
            {
                _bestLapSession = reported;
            }
            // Sector splits are timed client-side from lap progress — no wire
            // change, no server work. Progress only advances once the race is
            // live, so the countdown never pollutes sector 1.
            if (snap.Started && !snap.Finished)
            {
                TrackSectorProgress(localCar.LapProgress, snap.ElapsedRaceTime);
            }
        }

        if (snap.LatestDialogue is { } d && !string.IsNullOrEmpty(d.Text))
        {
            if (!string.Equals(d.OfficialId, _currentDialogueOfficialId, StringComparison.Ordinal))
            {
                // Swap dialogue owner to the speaker.
                if (_dialogueHandle is not null)
                {
                    try { JS.InvokeVoidAsync("PoCabinet.unmountDialogue", _dialogueHandle).GetAwaiter().GetResult(); } catch { }
                }
                _dialogueHandle = JS.InvokeAsync<IJSObjectReference>("PoCabinet.mountDialogue",
                    "pocabinetDialogueLayer", d.OfficialId).GetAwaiter().GetResult();
                _currentDialogueOfficialId = d.OfficialId;
            }
            if (_dialogueHandle is not null)
            {
                try { JS.InvokeVoidAsync("PoCabinet.showDialogue", _dialogueHandle, d.Text, 2400).GetAwaiter().GetResult(); } catch { }
                // Radio blip accompanies every bark now that audio exists.
                try { JS.InvokeVoidAsync("PoCabinet.blip").GetAwaiter().GetResult(); } catch { }
            }
            _announcement = d.Text;
        }

        if (snap.Finished && _phase != Phase.Finished)
        {
            _phase = Phase.Finished;
            // Final standings freeze from the last snapshot (position-ordered).
            _finalStandings = (snap.Cars ?? new List<PoCabinetCarState>())
                .OrderBy(c => c.Position)
                .ToList();
            // Engine to idle + a short arpeggio — brighter on a podium finish.
            try { JS.InvokeVoidAsync("PoCabinet.setSquealAudio", false).GetAwaiter().GetResult(); } catch { }
            try { JS.InvokeVoidAsync("PoCabinet.updateEngineAudio", 0).GetAwaiter().GetResult(); } catch { }
            try { JS.InvokeVoidAsync("PoCabinet.fanfare", _position <= 3).GetAwaiter().GetResult(); } catch { }
            // Best-effort: submit the score immediately. The record-and-submit
            // service parks on offline; the page never blocks the UI on it.
            _ = InvokeAsync(SubmitFinalAsync);
        }
        InvokeAsync(StateHasChanged);
    }

    /// <summary>
    /// T11 (2026-09-17): when the server or the JS ticker reports the race
    /// finished, build a high-score request from the latest state and pipe
    /// it through <see cref="GameResultService.RecordAndSubmitPoCabinetAsync"/>.
    /// BestLap comes from the snapshot when present (server path), otherwise
    /// it falls back to <c>0</c> and the server's <c>SavePoCabinetHighScoreAsync</c>
    /// refuses to save a non-positive time — that's the documented contract.
    /// </summary>
    private async Task SubmitFinalAsync()
    {
        try
        {
            var lapSeconds = _lastSnapshot?.BestLapSeconds ?? 0;
            var trackId = _trackId ?? PoCabinetCatalog.DefaultTrackId;

            // Persist personal records (best lap + best sector splits) and
            // learn whether this race set a new lap PB — the results card
            // shows both. Runs before the submit early-return so sector
            // splits from a race without a valid lap still persist.
            try
            {
                var res = await JS.InvokeAsync<JsonElement>("PoCabinet.recordTrackResult",
                    trackId, lapSeconds, BestSectorArray());
                if (res.ValueKind == JsonValueKind.Object)
                {
                    if (res.TryGetProperty("isPb", out var pb) && pb.ValueKind == JsonValueKind.True)
                        _isPersonalBest = true;
                    if (res.TryGetProperty("previousBest", out var prev) && prev.ValueKind == JsonValueKind.Number)
                        _previousBest = prev.GetDouble();
                }
            }
            catch { /* records are a bonus */ }

            if (lapSeconds <= 0)
            {
                _status = "Race finished (no best-lap recorded).";
                await InvokeAsync(StateHasChanged);
                return;
            }
            // GameResult is an enum (ConnectFive/TicTacToe absorbed GameOutcome
            // on 2026-09-13). A top-3 cabinet finish counts as a Win for local
            // stats; everything below is a Loss.
            var outcome = _position <= 3 ? GameResult.Win : GameResult.Loss;
            var isGuest = !(await IsAuthenticatedAsync());
            var req = new PoCabinetHighScoreRequest(
                TrackId: trackId,
                BestLapSeconds: lapSeconds,
                FinalPosition: Math.Clamp(_position, 1, 9),
                IsGuest: isGuest,
                GameCode: _gameCode ?? "SOLO");
            await GameResults.RecordAndSubmitPoCabinetAsync(_playerName, outcome, req);

            // Career progression: championship-tracked tracks advance on a podium finish.
            var stageIndex = StageIndexFor(trackId);
            if (stageIndex >= 0)
            {
                await Career.RecordStageResultAsync(stageIndex, _position, isFinalRace: stageIndex == 2);
            }
            _status = $"Race saved — position {_position}/{_totalCars}.";
            await InvokeAsync(StateHasChanged);
        }
        catch (Exception ex)
        {
            _status = $"Score submit failed: {ex.Message}";
            await InvokeAsync(StateHasChanged);
        }
    }

    // ─── Telemetry: sectors, laps, personal records ──────────────────────────

    /// <summary>Clear per-race telemetry. Called before every race (solo + wire).</summary>
    private void ResetTelemetry()
    {
        _sectorIndex = 0;
        _sectorStart = 0;
        _lineAligned = false;
        _prevProgress = 0;
        _sectorTimes = new double?[3];
        _lastLapSectorTimes = new double?[3];
        _sessionBestSectors.AsSpan().Fill(double.MaxValue);
        _lapTimes = new List<double>();
        _lastLapSeconds = 0;
        _bestLapSession = 0;
        _lastLapCount = 0;
        _lastLapTime = 0;
        _lastCountdown = -1;
        _goUntilElapsed = 0;
        _showGo = false;
        _countdownDisplay = 0;
        _finalStandings = null;
        _isPersonalBest = false;
        _previousBest = -1;
        _pingMs = null;
    }

    /// <summary>Pull this track's stored personal records for delta coloring.</summary>
    private async Task LoadStoredRecordsAsync(string trackId)
    {
        _storedBestSectors.AsSpan().Fill(double.MaxValue);
        _storedBestLap = 0;
        try
        {
            var rec = await JS.InvokeAsync<JsonElement>("PoCabinet.getRecords", trackId);
            if (rec.ValueKind != JsonValueKind.Object) return;
            if (rec.TryGetProperty("bestLap", out var bl) && bl.ValueKind == JsonValueKind.Number)
            {
                var v = bl.GetDouble();
                if (v > 0) _storedBestLap = v;
            }
            if (rec.TryGetProperty("sectors", out var secs) && secs.ValueKind == JsonValueKind.Array)
            {
                var i = 0;
                foreach (var s in secs.EnumerateArray())
                {
                    if (i >= 3) break;
                    if (s.ValueKind == JsonValueKind.Number)
                    {
                        var v = s.GetDouble();
                        if (v > 0) _storedBestSectors[i] = v;
                    }
                    i++;
                }
            }
        }
        catch { /* first race ever, or storage unavailable — defaults hold */ }
    }

    private void TrackSectorProgress(double progress, double elapsed)
    {
        // Sector boundaries are absolute thirds of the oval: the lap line sits
        // at progress 0 (the wrap the lap counter uses), so thirds only line up
        // once the first line crossing has happened. The standing-start lap
        // records just its closing stint in CloseLapTelemetry.
        if (!_lineAligned) return;
        while (_sectorIndex < 2)
        {
            var boundary = (_sectorIndex + 1) / 3.0;
            if (!CrossedBoundary(_prevProgress, progress, boundary)) break;
            RecordSector(elapsed - _sectorStart, _sectorIndex);
            _sectorIndex++;
            _sectorStart = elapsed;
        }
        _prevProgress = progress;
    }

    /// <summary>True when the monotone progress curve (which wraps at 1→0) crossed the boundary.</summary>
    private static bool CrossedBoundary(double prev, double cur, double boundary)
    {
        if (prev <= cur) return prev < boundary && boundary <= cur;
        return boundary > prev || boundary <= cur; // wrapped this step
    }

    /// <summary>
    /// Close out the lap: finish sector 3 (lap minus the two recorded splits),
    /// freeze the splits for the results table, and reset for the next lap.
    /// On the standing-start lap s1/s2 are skipped (not line-aligned yet), so
    /// s3 absorbs the whole grid stint and the splits always sum to the lap.
    /// </summary>
    private void CloseLapTelemetry(double lapTime, double elapsed)
    {
        RecordSector(lapTime - (_sectorTimes[0] ?? 0) - (_sectorTimes[1] ?? 0), 2);
        _lastLapSectorTimes = (double?[])_sectorTimes.Clone();
        _sectorTimes = new double?[3];
        _sectorIndex = 0;
        _sectorStart = elapsed;
        _lineAligned = true;
        _prevProgress = 0; // the lap line sits at progress 0
        if (lapTime > 0)
        {
            _lastLapSeconds = lapTime;
            _lapTimes.Add(lapTime);
        }
        // Lap times are elapsed-since-last-line; the caller no longer updates this.
        _lastLapTime = elapsed;
    }

    private void RecordSector(double seconds, int index)
    {
        if (seconds <= 0 || index < 0 || index > 2) return;
        _sectorTimes[index] = seconds;
        if (seconds < _sessionBestSectors[index]) _sessionBestSectors[index] = seconds;
    }

    /// <summary>CSS class for a completed sector chip: green beats the stored PB, purple is session-best.</summary>
    protected string SectorClass(int index)
    {
        if (index < 0 || index > 2) return "";
        var t = _sectorTimes[index];
        if (t is null) return "";
        if (t.Value <= _storedBestSectors[index]) return "pocabinet-sector--pb";
        if (t.Value <= _sessionBestSectors[index]) return "pocabinet-sector--session";
        return "";
    }

    /// <summary>Same classification for the results table (last completed lap).</summary>
    protected string SectorClassFor(double? t, int index)
    {
        if (t is null || index < 0 || index > 2) return "";
        if (t.Value <= _storedBestSectors[index]) return "pocabinet-sector--pb";
        if (t.Value <= _sessionBestSectors[index]) return "pocabinet-sector--session";
        return "";
    }

    /// <summary>Session-best sectors for persistence; 0 marks "not set" and is skipped by the JS store.</summary>
    private double[] BestSectorArray() => new[]
    {
        _sessionBestSectors[0] < 3600 ? Math.Round(_sessionBestSectors[0], 2) : 0,
        _sessionBestSectors[1] < 3600 ? Math.Round(_sessionBestSectors[1], 2) : 0,
        _sessionBestSectors[2] < 3600 ? Math.Round(_sessionBestSectors[2], 2) : 0,
    };

    private static string AccentFor(string trackId) => trackId switch
    {
        "maralago" => "#f0e6c8",
        "pressbriefing" => "#c1253b",
        _ => "#c6a35a",
    };

    // ─── Pause (solo only) ───────────────────────────────────────────────────

    /// <summary>Toggle from the HUD button or the Esc key (JS routes both here).</summary>
    [JSInvokable]
    public Task OnTogglePause() => TogglePauseAsync();

    protected async Task TogglePauseAsync()
    {
        if (!Pausable) return;
        if (_paused) await ResumeRaceAsync();
        else await PauseRaceAsync();
    }

    protected async Task PauseRaceAsync()
    {
        if (_paused || !Pausable) return;
        _paused = true;
        try
        {
            await JS.InvokeVoidAsync("PoCabinet.pauseSoloRace");
            await JS.InvokeVoidAsync("PoCabinet.setAudioSuspended", true);
        }
        catch { /* engine may be mid-teardown */ }
        await InvokeAsync(StateHasChanged);
    }

    protected async Task ResumeRaceAsync()
    {
        if (!_paused) return;
        _paused = false;
        try
        {
            await JS.InvokeVoidAsync("PoCabinet.resumeSoloRace");
            await JS.InvokeVoidAsync("PoCabinet.setAudioSuspended", false);
        }
        catch { /* engine may be mid-teardown */ }
        await InvokeAsync(StateHasChanged);
    }

    protected async Task QuitToMenuAsync()
    {
        try
        {
            await JS.InvokeVoidAsync("PoCabinet.stopSoloRace");
            await JS.InvokeVoidAsync("PoCabinet.setAudioSuspended", true);
        }
        catch { /* engine may be mid-teardown */ }
        _paused = false;
        _phase = Phase.Start;
        await InvokeAsync(StateHasChanged);
    }

    // ─── Settings ────────────────────────────────────────────────────────────

    /// <summary>Settings panel callback: persist + apply live without remounting the race.</summary>
    protected async Task OnSettingsChangedAsync()
    {
        try
        {
            await JS.InvokeVoidAsync("PoCabinet.saveSettings", Settings.ToJs());
            if (_sceneHandle is not null)
            {
                await JS.InvokeVoidAsync("PoCabinet.applySettings", _sceneHandle, Settings.ToJs());
            }
        }
        catch { /* cosmetic */ }

        // Colorblind palette is baked into the minimap at mount — remount it.
        if (_minimapHandle is not null)
        {
            var trackId = _trackId ?? PoCabinetCatalog.DefaultTrackId;
            try
            {
                await JS.InvokeVoidAsync("PoCabinet.unmountMinimap", _minimapHandle);
                var (_, centerline) = PoCabinetScenePresets.ForTrack(trackId);
                _minimapHandle = await JS.InvokeAsync<IJSObjectReference>("PoCabinet.mountMinimap",
                    "pocabinetMinimap", centerline, new { accent = AccentFor(trackId), colorSafe = Settings.ColorSafe });
            }
            catch { _minimapHandle = null; }
        }

        // Weather / time-of-day changes re-resolve the environment layer.
        var envKey = $"{Settings.Weather}|{Settings.TimeOfDay}";
        if (!string.Equals(envKey, _envKey, StringComparison.Ordinal))
        {
            _envKey = envKey;
            if (_sceneHandle is not null)
            {
                try { if (_envHandle is not null) await JS.InvokeVoidAsync("PoCabinet.unmountEnvironment", _envHandle); } catch { }
                try { _envHandle = await JS.InvokeAsync<IJSObjectReference>("PoCabinet.mountEnvironment", _sceneHandle); }
                catch { _envHandle = null; }
            }
        }
        await InvokeAsync(StateHasChanged);
    }

    // ─── Share ───────────────────────────────────────────────────────────────

    /// <summary>Render the result card to a PNG and hand it to the share sheet (or download it).</summary>
    protected async Task ShareResultAsync()
    {
        var trackId = _trackId ?? PoCabinetCatalog.DefaultTrackId;
        try
        {
            var outcome = await JS.InvokeAsync<string>("PoCabinet.shareResult", new
            {
                playerName = _playerName,
                trackName = PoCabinetCatalog.GetTrack(trackId).Name,
                position = _position,
                totalCars = _totalCars,
                bestLapSeconds = _lastSnapshot?.BestLapSeconds ?? 0,
                isPb = _isPersonalBest,
                accent = AccentFor(trackId),
            });
            _status = outcome switch
            {
                "shared" => "Result card shared.",
                "downloaded" => "Result card downloaded.",
                _ => "Sharing unavailable — the card was downloaded instead.",
            };
        }
        catch (Exception ex)
        {
            _status = $"Could not create the result card: {ex.Message}";
        }
        await InvokeAsync(StateHasChanged);
    }

    private static int StageIndexFor(string trackId) => trackId switch
    {
        "capitol" => 0,
        "maralago" => 1,
        "pressbriefing" => 2,
        _ => -1,
    };

    private Task<bool> IsAuthenticatedAsync() => Task.FromResult(AuthState?.IsAuthenticated == true);

    /// <summary>Called from JS when a key state flips. In solo mode this is
    /// diagnostic — the in-browser practice ticker reads the keyboard
    /// directly, so we just forward to the session so multiplayer (when
    /// wired up) sees the same intent stream. Also drives the tire-squeal
    /// audio layer: hard steering at pace.</summary>
    [JSInvokable]
    public async Task OnInputAsync(bool up, bool down, bool left, bool right)
    {
        var squealing = (left || right) && _speedKmh > 110
            && _phase == Phase.Racing && !_paused;
        try { await JS.InvokeVoidAsync("PoCabinet.setSquealAudio", squealing); }
        catch { /* audio is a bonus */ }
        await Session.SendInputAsync(new PoCabinetInput
        {
            Up = up,
            Down = down,
            Left = left,
            Right = right,
        });
    }

    protected static string FormatLapTime(double seconds)
    {
        if (double.IsNaN(seconds) || seconds < 0) return "0:00.0";
        var minutes = (int)(seconds / 60);
        var rest = seconds - minutes * 60;
        return $"{minutes}:{rest:0.0}";
    }

    public async ValueTask DisposeAsync()
    {
        // Halt the solo ticker and duck any live audio before teardown — the
        // engine hum must not outlive the page it belongs to.
        try { await JS.InvokeVoidAsync("PoCabinet.stopSoloRace"); } catch { }
        try { await JS.InvokeVoidAsync("PoCabinet.setAudioSuspended", true); } catch { }
        try
        {
            if (_envHandle is not null)
                await JS.InvokeVoidAsync("PoCabinet.unmountEnvironment", _envHandle);
            if (_minimapHandle is not null)
                await JS.InvokeVoidAsync("PoCabinet.unmountMinimap", _minimapHandle);
            if (_dialogueHandle is not null)
                await JS.InvokeVoidAsync("PoCabinet.unmountDialogue", _dialogueHandle);
            foreach (var h in _carHandles.Values)
            {
                try { await JS.InvokeVoidAsync("PoCabinet.unmountCar", h); } catch { }
            }
            _carHandles.Clear();
            if (_cockpitHandle is not null)
                await JS.InvokeVoidAsync("PoCabinet.unmountCockpit", _cockpitHandle);
            if (_sceneHandle is not null)
                await JS.InvokeVoidAsync("PoCabinet.unmount", _sceneHandle);
        }
        catch { /* engine may already be torn down */ }
        _selfRef?.Dispose();
    }
}

internal static class PoCabinetScenePresets
{
    /// <summary>
    /// Returns the atmosphere + centerline for the given track. Mirrors
    /// <c>PoCabinetTrackRegistry</c> on the server — three themed presets
    /// sized to fit the cockpit camera. Car radius is constant between
    /// client and server (14u), so the client can use the same numbers
    /// without unit-conversion.
    /// </summary>
    public static (object Atmosphere, double[][] Centerline) ForTrack(string trackId) =>
        trackId switch
        {
            "capitol" => (CapitolAtmosphere, PillCenterline(rx: 280, ry: 180, sampleCount: 220)),
            "maralago" => (MarALagoAtmosphere, PillCenterline(rx: 320, ry: 200, sampleCount: 220)),
            "pressbriefing" => (PressBriefingAtmosphere, PillCenterline(rx: 260, ry: 160, sampleCount: 220)),
            _ => (CapitolAtmosphere, PillCenterline(rx: 280, ry: 180, sampleCount: 220)),
        };

    /// <summary>Generate an ellipse with rounded straight segments ("pill oval").</summary>
    private static double[][] PillCenterline(double rx, double ry, int sampleCount)
    {
        var pts = new double[sampleCount][];
        for (int i = 0; i < sampleCount; i++)
        {
            var t = (double)i / sampleCount * 2 * Math.PI;
            pts[i] = new[] { rx * Math.Cos(t), ry * Math.Sin(t) };
        }
        return pts;
    }

    private static object CapitolAtmosphere => new
    {
        skyHex = "#14233f",
        fogStart = 220.0,
        fogEnd = 900.0,
        fogHex = "#14233f",
        ambientIntensity = 0.5,
        groundHex = "#1c1c1c",
        accentHex = "#c6a35a", // gold
    };

    private static object MarALagoAtmosphere => new
    {
        skyHex = "#79a9d3",
        fogStart = 260.0,
        fogEnd = 1100.0,
        fogHex = "#79a9d3",
        ambientIntensity = 0.7,
        groundHex = "#c2c98a",
        accentHex = "#f0e6c8",
    };

    private static object PressBriefingAtmosphere => new
    {
        skyHex = "#1a0d1a",
        fogStart = 200.0,
        fogEnd = 820.0,
        fogHex = "#1a0d1a",
        ambientIntensity = 0.45,
        groundHex = "#2a1722",
        accentHex = "#c1253b", // podium red
    };
}
