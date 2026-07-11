namespace PoMiniGamesClient.Services;

/// <summary>
/// Global app settings shared by every game: master mute and FPS-badge
/// visibility. Persisted as plain localStorage flags (`pomini_muted` /
/// `pomini_showfps`, values "1"/"0") so JS modules (uiAudio.js, game engines)
/// can read them directly without interop round-trips.
/// </summary>
public sealed class SettingsService
{
    private const string MutedKey = "pomini_muted";
    private const string ShowFpsKey = "pomini_showfps";

    /// <summary>Raised after any setting changes so UI and game pages can react.</summary>
    public event Action? Changed;

    public bool Muted { get; private set; }
    public bool ShowFps { get; private set; } = true;

    /// <summary>Read persisted values. Call once JS interop is available.</summary>
    public void Load()
    {
        try
        {
            Muted = LocalStorageService.GetItem<string>(MutedKey) == "1";
            ShowFps = LocalStorageService.GetItem<string>(ShowFpsKey) != "0";
        }
        catch { /* pre-render — defaults stand */ }
    }

    public void SetMuted(bool muted)
    {
        Muted = muted;
        LocalStorageService.SetItem(MutedKey, muted ? "1" : "0");
        Changed?.Invoke();
    }

    public void SetShowFps(bool show)
    {
        ShowFps = show;
        LocalStorageService.SetItem(ShowFpsKey, show ? "1" : "0");
        Changed?.Invoke();
    }
}
