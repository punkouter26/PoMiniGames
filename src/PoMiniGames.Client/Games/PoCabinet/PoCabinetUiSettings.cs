using System.Globalization;

namespace PoMiniGamesClient.Games.PoCabinet;

/// <summary>
/// Player-tunable presentation settings for PoCabinet, mirrored from the JS
/// store (<c>wwwroot/js/pocabinet/settings.js</c>). JavaScript owns the disk
/// format (localStorage + sanitisation); this class is the Blazor-side view
/// model the settings panel binds to. The <see cref="ToJs"/> projection must
/// stay key-compatible with the JS defaults — a rename on either side silently
/// reverts the player's pref to its default.
/// </summary>
public sealed class PoCabinetUiSettings
{
    public double MasterVolume { get; set; } = 0.7;
    public bool Muted { get; set; }
    public double RenderScale { get; set; } = 1;
    public double Fov { get; set; } = 70;
    public double HudScale { get; set; } = 1;
    public bool ReducedMotion { get; set; }
    public bool ColorSafe { get; set; }
    public string Weather { get; set; } = "auto";
    public string TimeOfDay { get; set; } = "auto";

    /// <summary>Load from a <c>PoCabinet.loadSettings()</c> JSON element, keeping defaults for missing props.</summary>
    public void LoadFrom(System.Text.Json.JsonElement el)
    {
        if (el.ValueKind != System.Text.Json.JsonValueKind.Object) return;
        MasterVolume = GetDouble(el, "masterVolume", MasterVolume);
        Muted = GetBool(el, "muted", Muted);
        RenderScale = GetDouble(el, "renderScale", RenderScale);
        Fov = GetDouble(el, "fov", Fov);
        HudScale = GetDouble(el, "hudScale", HudScale);
        ReducedMotion = GetBool(el, "reducedMotion", ReducedMotion);
        ColorSafe = GetBool(el, "colorSafe", ColorSafe);
        Weather = GetString(el, "weather", Weather);
        TimeOfDay = GetString(el, "timeOfDay", TimeOfDay);
    }

    /// <summary>Key-compatible projection passed to <c>PoCabinet.saveSettings</c>/<c>applySettings</c>.</summary>
    public object ToJs() => new
    {
        masterVolume = MasterVolume,
        muted = Muted,
        renderScale = RenderScale,
        fov = Fov,
        hudScale = HudScale,
        reducedMotion = ReducedMotion,
        colorSafe = ColorSafe,
        weather = Weather,
        timeOfDay = TimeOfDay,
    };

    /// <summary>HudScale formatted invariantly for the <c>--pocabinet-hud</c> CSS custom property.</summary>
    public string HudScaleCss => HudScale.ToString(CultureInfo.InvariantCulture);

    private static double GetDouble(System.Text.Json.JsonElement el, string name, double fallback)
    {
        if (el.TryGetProperty(name, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.Number)
        {
            var d = v.GetDouble();
            if (!double.IsNaN(d)) return d;
        }
        return fallback;
    }

    private static bool GetBool(System.Text.Json.JsonElement el, string name, bool fallback) =>
        el.TryGetProperty(name, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.True ? true
        : v.ValueKind == System.Text.Json.JsonValueKind.False ? false
        : fallback;

    private static string GetString(System.Text.Json.JsonElement el, string name, string fallback)
    {
        if (el.TryGetProperty(name, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.String)
        {
            var s = v.GetString();
            if (!string.IsNullOrWhiteSpace(s)) return s;
        }
        return fallback;
    }
}
