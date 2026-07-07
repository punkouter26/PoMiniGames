using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Routing;

namespace PoMiniGamesClient.Services;

/// <summary>
/// Centralized manager for the "Watch All Demos" auto-rotation kiosk mode.
///
/// Fixes a critical bug where each demo page created its own private
/// <c>System.Threading.Timer</c> for the 20s advance-to-next-demo logic.
/// Those timers survived Blazor's enhanced navigation and continued to fire
/// after the user manually navigated to another page, hijacking the user
/// back into the kiosk cycle. They also raced with each demo's own
/// "restart on game-over" loop, causing infinite re-loops on some pages
/// (notably PoFight).
///
/// Design contract:
///   • Only ONE kiosk timer exists for the lifetime of the Blazor session.
///   • Demo pages <c>Register</c> themselves (catalog) and call
///     <c>SetCurrent(key)</c> to report which demo is on screen. The
///     coordinator owns the timer, so canceling or stopping is centralized.
///   • On any <see cref="NavigationManager.LocationChanged"/>:
///       – Kiosk-internal navigations carry <c>?kiosk=N</c> in the URL.
///         The coordinator re-targets the timer to the new index and keeps
///         ticking, so the auto-rotation actually rotates.
///       – Any other navigation (Home, single-player, etc.) cancels the
///         active timer to prevent a stale timer from yanking the user
///         back into the kiosk cycle.
///   • Users can Pause/Resume/Skip/Exit via the on-screen kiosk control
///     bar (see <c>KioskControlBar.razor</c>).
/// </summary>
public sealed class KioskCoordinator : IDisposable
{
    private readonly NavigationManager _navigation;
    private readonly List<DemoEntry> _entries = new();
    private System.Threading.Timer? _timer;
    private string? _currentKey;
    private int _currentIndex;
    private bool _isPaused;
    private int _advanceIndex; // index of the demo to jump to on the next advance
    private bool _disposed;

    public event Action? Changed;

    public KioskCoordinator(NavigationManager navigation)
    {
        _navigation = navigation;
        _navigation.LocationChanged += OnLocationChanged;
    }

    public bool IsActive => _timer is not null;
    public bool IsPaused => _isPaused;
    public string? CurrentGameName { get; private set; }
    public int SecondsUntilAdvance { get; private set; } = 20;
    public const int AdvanceSeconds = 20;

    // Per-game dwell: fast games (a rhythm tap, a quick round) get a shorter slice so the
    // reel doesn't sit on a restart; slower ones (a full race, a comedy bit) get longer.
    // Keyed by the catalog GameKey (DemoEntry.Key). Anything unmapped uses AdvanceSeconds.
    private static readonly Dictionary<string, int> DwellByKey = new(StringComparer.OrdinalIgnoreCase)
    {
        ["poclick"] = 12,
        ["tictactoe"] = 12,
        ["connectfive"] = 14,
        ["poraceragdoll"] = 14,
        ["pofight"] = 16,
        ["pohorserace"] = 16,
        ["poracer"] = 18,
        ["pomarblerace"] = 22,
        ["pojoker"] = 24,
        ["pobrawl"] = 22,
        ["posurvive"] = 24,
    };

    private int DwellFor(int index) =>
        index >= 0 && index < _entries.Count && DwellByKey.TryGetValue(_entries[index].Key, out var s)
            ? s : AdvanceSeconds;

    public IReadOnlyList<DemoEntry> Entries => _entries;

    public void RegisterEntries(IEnumerable<DemoEntry> entries)
    {
        _entries.Clear();
        _entries.AddRange(entries);
        Changed?.Invoke();
    }

    public void SetCurrent(string key)
    {
        _currentKey = key;
        CurrentGameName = _entries.FirstOrDefault(e => e.Key == key)?.DisplayName;
        _currentIndex = _entries.FindIndex(e => e.Key == key);
        SecondsUntilAdvance = AdvanceSeconds;
        Changed?.Invoke();
    }

    public void Start(int advanceIndex)
    {
        Stop();
        _advanceIndex = advanceIndex;
        _timer = new System.Threading.Timer(_ => OnTick(), null, 1000, 1000);
        Changed?.Invoke();
    }

    public void Stop()
    {
        _timer?.Dispose();
        _timer = null;
        _isPaused = false;
        SecondsUntilAdvance = AdvanceSeconds;
        Changed?.Invoke();
    }

    public void Pause() { _isPaused = true; Changed?.Invoke(); }
    public void Resume() { _isPaused = false; Changed?.Invoke(); }
    public void TogglePause() { _isPaused = !_isPaused; Changed?.Invoke(); }

    public void SkipNext()
    {
        _timer?.Dispose();
        _timer = null;
        var next = (_advanceIndex + 1) % _entries.Count;
        var nextEntry = _entries[next];
        var sep = nextEntry.Path.Contains('?') ? '&' : '?';
        _navigation.NavigateTo($"{nextEntry.Path}{sep}kiosk={next}", forceLoad: false);
        Changed?.Invoke();
    }

    public void Exit()
    {
        Stop();
        _navigation.NavigateTo("/", forceLoad: false);
    }

    private void OnTick()
    {
        if (_disposed || _timer is null) return;
        if (_isPaused) return;
        SecondsUntilAdvance--;
        Changed?.Invoke();
        if (SecondsUntilAdvance <= 0)
        {
            // Advance to next kiosk index. The SinglePlayerPage will pick
            // up the new index and route to the corresponding demo game.
            _timer?.Dispose();
            _timer = null;
            var next = (_advanceIndex + 1) % _entries.Count;
            var nextEntry = _entries[next];
            var sep = nextEntry.Path.Contains('?') ? '&' : '?';
            _navigation.NavigateTo($"{nextEntry.Path}{sep}kiosk={next}", forceLoad: false);
        }
    }

    private void OnLocationChanged(object? sender, LocationChangedEventArgs e)
    {
        // Kiosk-internal navigations carry ?kiosk=N in the query string —
        // these are emitted by the coordinator itself (Start, OnTick,
        // SkipNext) and must NOT cancel the timer, otherwise the very first
        // call to Start() followed by NavigateTo(...) would dispose the
        // timer before the first tick. Re-target the countdown to the new
        // index and (re)arm the timer if the previous non-kiosk navigation
        // had killed it.
        if (TryGetKioskIndex(e.Location, out var kioskIndex))
        {
            _advanceIndex = kioskIndex;
            SecondsUntilAdvance = DwellFor(kioskIndex);
            if (_timer is null && !_disposed)
            {
                _timer = new System.Threading.Timer(_ => OnTick(), null, 1000, 1000);
            }
            Changed?.Invoke();
            return;
        }

        // Any non-kiosk location change cancels the auto-tick. This is what
        // stops the "stale timer hijacks manual navigation" bug — if the
        // user clicks Home or a single-player game, the kiosk cycle stops
        // instead of yanking them back 20s later.
        if (_timer is not null)
        {
            _timer.Dispose();
            _timer = null;
            Changed?.Invoke();
        }
    }

    // Parses ?kiosk=N (or &kiosk=N) from a URL. Returns true and the index
    // when present and a non-negative integer; false otherwise.
    private static bool TryGetKioskIndex(string url, out int index)
    {
        index = 0;
        var qIdx = url.IndexOf('?');
        if (qIdx < 0) return false;
        foreach (var part in url[(qIdx + 1)..].Split('&'))
        {
            var eq = part.IndexOf('=');
            if (eq <= 0) continue;
            if (!string.Equals(part[..eq], "kiosk", StringComparison.OrdinalIgnoreCase)) continue;
            return int.TryParse(part[(eq + 1)..], out index) && index >= 0;
        }
        return false;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _navigation.LocationChanged -= OnLocationChanged;
        _timer?.Dispose();
        _timer = null;
    }
}

public sealed record DemoEntry(string Key, string Path, string DisplayName, string Icon);
