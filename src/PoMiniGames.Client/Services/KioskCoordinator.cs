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
///   • Demo pages <c>Register</c> themselves and report the game URL on
///     advance. The coordinator owns the timer, so canceling or stopping
///     is centralized.
///   • On any <see cref="NavigationManager.LocationChanged"/> the
///     coordinator stops the active timer and lets the new page
///     re-register. This prevents stale timers from hijacking manual
///     navigation.
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
    private int _advanceIndex; // index passed to /single-player?mode=demo&kiosk=N
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
        _navigation.NavigateTo("/single-player?mode=demo", forceLoad: false);
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
        // Any location change cancels the auto-tick. The new page is
        // responsible for calling Start() again if it wants to continue
        // the cycle. This is what stops the "stale timer hijacks
        // navigation" bug.
        if (_timer is not null)
        {
            _timer.Dispose();
            _timer = null;
            Changed?.Invoke();
        }
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
