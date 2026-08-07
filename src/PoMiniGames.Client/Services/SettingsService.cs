using Microsoft.JSInterop;

namespace PoMiniGamesClient.Services;

/// <summary>How the app picks its colour scheme.</summary>
public enum ThemeMode
{
    /// <summary>Follow the OS preference, and keep following it if it changes mid-session.</summary>
    Auto,
    Light,
    Dark,
}

/// <summary>
/// Global app settings shared by every game: colour scheme, master mute and
/// volume, haptics, reduced motion, and FPS-badge visibility. Persisted as plain
/// localStorage values (<c>pomini_muted</c>, <c>pomini_showfps</c>,
/// <c>pomini_theme</c>, <c>pomini_volume</c>, <c>pomini_haptics</c>,
/// <c>pomini_reducedmotion</c>) so JS modules (uiAudio.js, audioBus.js, the
/// index.html pre-paint theme script, game engines) can read them directly
/// without an interop round-trip.
/// </summary>
/// <remarks>
/// Two of these settings are enforced entirely on the JS side and are read from
/// storage there rather than pushed from here:
/// <list type="bullet">
/// <item>volume — audioBus.js reads it when it builds the graph, which can
/// happen before this service has run any interop.</item>
/// <item>haptics — uiAudio.js reads it per vibration.</item>
/// </list>
/// The setters below still call into JS so a change applies to the <i>live</i>
/// audio graph immediately instead of only after the next reload.
/// </remarks>
public sealed class SettingsService : IAsyncDisposable
{
    private const string MutedKey = "pomini_muted";
    private const string ShowFpsKey = "pomini_showfps";
    private const string ThemeKey = "pomini_theme";
    private const string VolumeKey = "pomini_volume";
    private const string HapticsKey = "pomini_haptics";
    private const string ReducedMotionKey = "pomini_reducedmotion";

    private readonly Lazy<Task<IJSObjectReference>> _prefs;
    private bool _disposed;

    public SettingsService(IJSRuntime js)
    {
        _prefs = new Lazy<Task<IJSObjectReference>>(() =>
            js.InvokeAsync<IJSObjectReference>("import", "./js/appPrefs.js").AsTask());
    }

    /// <summary>Raised after any setting changes so UI and game pages can react.</summary>
    public event Action? Changed;

    public bool Muted { get; private set; }

    // FPS badge. OFF by default: it is a developer diagnostic, and defaulting it on
    // put a rendering counter in the centre of the top bar — the most valuable chrome
    // on every page — for every player, most of whom have no use for it. Opt in via
    // /settings; /diag reports the same number for one-off checks.
    public bool ShowFps { get; private set; }

    /// <summary>Colour scheme. <see cref="ThemeMode.Auto"/> tracks the OS.</summary>
    public ThemeMode Theme { get; private set; } = ThemeMode.Auto;

    /// <summary>Master output volume as a percentage, 0–100.</summary>
    public int Volume { get; private set; } = 100;

    /// <summary>Whether vibration cues fire on devices that support them.</summary>
    public bool Haptics { get; private set; } = true;

    /// <summary>
    /// The user's own request for less motion. Independent of the OS
    /// <c>prefers-reduced-motion</c> setting, which always applies on its own —
    /// turning this off never re-enables motion for someone whose OS asked to
    /// reduce it.
    /// </summary>
    public bool ReducedMotion { get; private set; }

    /// <summary>Read persisted values. Call once JS interop is available.</summary>
    public void Load()
    {
        try
        {
            Muted = LocalStorageService.GetItem<string>(MutedKey) == "1";
            // Default off; an explicit "1" is the only thing that shows the badge, so
            // a user who opted in keeps it across reloads.
            ShowFps = LocalStorageService.GetItem<string>(ShowFpsKey) == "1";
            Theme = ParseTheme(LocalStorageService.GetItem<string>(ThemeKey));
            Volume = ParseVolume(LocalStorageService.GetItem<string>(VolumeKey));
            Haptics = LocalStorageService.GetItem<string>(HapticsKey) != "0";
            ReducedMotion = LocalStorageService.GetItem<string>(ReducedMotionKey) == "1";
        }
        catch { /* pre-render — defaults stand */ }
    }

    /// <summary>
    /// Anything unrecognised (including a missing key or a value written by an
    /// older build) means Auto — the safest reading of "no explicit choice".
    /// </summary>
    private static ThemeMode ParseTheme(string? raw) => raw switch
    {
        "light" => ThemeMode.Light,
        "dark" => ThemeMode.Dark,
        _ => ThemeMode.Auto,
    };

    /// <summary>
    /// Clamped to 0–100. A corrupt or missing value reads as full volume rather
    /// than 0, so a bad key never presents as broken audio.
    /// </summary>
    private static int ParseVolume(string? raw) =>
        int.TryParse(raw, out var pct) ? Math.Clamp(pct, 0, 100) : 100;

    private static string ThemeToStorage(ThemeMode mode) => mode switch
    {
        ThemeMode.Light => "light",
        ThemeMode.Dark => "dark",
        _ => "auto",
    };

    public async Task SetMutedAsync(bool muted)
    {
        Muted = muted;
        // audioBus.setMuted owns the storage key, same as volume — it writes
        // through on its way to the live gain node.
        Changed?.Invoke();
        await InvokeAsync("applyMuted", muted);
    }

    public void SetShowFps(bool show)
    {
        ShowFps = show;
        LocalStorageService.SetItem(ShowFpsKey, show ? "1" : "0");
        Changed?.Invoke();
    }

    public async Task SetThemeAsync(ThemeMode mode)
    {
        Theme = mode;
        LocalStorageService.SetItem(ThemeKey, ThemeToStorage(mode));
        Changed?.Invoke();
        await InvokeAsync("applyTheme", ThemeToStorage(mode));
    }

    public async Task SetVolumeAsync(int percent)
    {
        Volume = Math.Clamp(percent, 0, 100);
        // audioBus.setVolume writes the storage key itself (it is the owner of
        // both the gain node and the persisted value), so this does not also
        // write it here — two writers would be a chance for them to disagree.
        Changed?.Invoke();
        await InvokeAsync("applyVolume", Volume / 100.0);
    }

    public void SetHaptics(bool enabled)
    {
        Haptics = enabled;
        LocalStorageService.SetItem(HapticsKey, enabled ? "1" : "0");
        Changed?.Invoke();
    }

    public async Task SetReducedMotionAsync(bool reduce)
    {
        ReducedMotion = reduce;
        LocalStorageService.SetItem(ReducedMotionKey, reduce ? "1" : "0");
        Changed?.Invoke();
        await InvokeAsync("applyReducedMotion", reduce);
    }

    /// <summary>
    /// True when the OS itself asks for reduced motion, in which case the app is
    /// already calmer regardless of <see cref="ReducedMotion"/>. Used only to
    /// explain that in the settings UI.
    /// </summary>
    public async Task<bool> OsPrefersReducedMotionAsync()
    {
        if (_disposed) return false;
        try
        {
            var module = await _prefs.Value;
            return await module.InvokeAsync<bool>("prefersReducedMotion");
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Push the persisted values into the DOM and audio graph. Call once after
    /// first render: the pre-paint script in index.html has already stamped the
    /// theme, but nothing has wired up the OS-change listener for Auto mode yet.
    /// </summary>
    public async Task ApplyAsync()
    {
        await InvokeAsync("applyTheme", ThemeToStorage(Theme));
        if (ReducedMotion) await InvokeAsync("applyReducedMotion", true);
        // Volume and mute are not re-pushed here: audioBus.js reads both keys
        // itself when it builds the graph, which it may already have done. Re-
        // sending them would only risk constructing an AudioContext before the
        // first user gesture, which mobile autoplay policy rejects.
    }

    /// <summary>
    /// Best-effort interop. Preferences are an enhancement layered on top of a
    /// working app — a browser that cannot load the module keeps the defaults
    /// rather than failing a user action.
    /// </summary>
    private async Task InvokeAsync(string fn, object arg)
    {
        if (_disposed) return;
        try
        {
            var module = await _prefs.Value;
            await module.InvokeVoidAsync(fn, arg);
        }
        catch
        {
            // Best-effort — never throw from a settings path.
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        if (_prefs.IsValueCreated)
        {
            try
            {
                var module = await _prefs.Value;
                await module.DisposeAsync();
            }
            catch { /* module never loaded — fine */ }
        }
    }
}
