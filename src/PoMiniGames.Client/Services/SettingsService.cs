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
/// volume, haptics and reduced motion. Persisted as plain localStorage values
/// (<c>pomini_muted</c>, <c>pomini_theme</c>, <c>pomini_volume</c>,
/// <c>pomini_haptics</c>, <c>pomini_reducedmotion</c>) so JS modules (uiAudio.js,
/// audioBus.js, the index.html pre-paint theme script, game engines) can read
/// them directly without an interop round-trip.
/// </summary>
/// <remarks>
/// <para>
/// 2026-08-11 (user request): the /settings page and its SettingsPanel were
/// removed, so nothing in the app writes these any more — this is now a
/// read-and-apply service. It still exists rather than being folded into
/// constants because the values it reads are the ones JS already owns:
/// audioBus.js writes <c>pomini_muted</c>/<c>pomini_volume</c> as it builds the
/// audio graph, and the pre-paint script reads <c>pomini_theme</c>. Anything a
/// player set before the page was removed is therefore still honoured; a fresh
/// browser gets the defaults below (Auto theme, unmuted, full volume, haptics on,
/// motion unreduced).
/// </para>
/// <para>
/// The FPS badge used to be gated here too (<c>pomini_showfps</c>, default off).
/// It is now unconditional in the top bar, so the flag is gone — see
/// Components/FpsCounter.razor. The "show game intros" flag went the same way:
/// the controls card now opens every 1-player game.
/// </para>
/// </remarks>
public sealed class SettingsService : IAsyncDisposable
{
    private const string MutedKey = "pomini_muted";
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

    public bool Muted { get; private set; }

    /// <summary>Colour scheme. <see cref="ThemeMode.Auto"/> tracks the OS.</summary>
    public ThemeMode Theme { get; private set; } = ThemeMode.Auto;

    /// <summary>Master output volume as a percentage, 0–100.</summary>
    public int Volume { get; private set; } = 100;

    /// <summary>Whether vibration cues fire on devices that support them.</summary>
    public bool Haptics { get; private set; } = true;

    /// <summary>
    /// The user's own request for less motion. Independent of the OS
    /// <c>prefers-reduced-motion</c> setting, which always applies on its own —
    /// this being false never re-enables motion for someone whose OS asked to
    /// reduce it.
    /// </summary>
    public bool ReducedMotion { get; private set; }

    /// <summary>Read persisted values. Call once JS interop is available.</summary>
    public void Load()
    {
        try
        {
            Muted = LocalStorageService.GetItem<string>(MutedKey) == "1";
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
