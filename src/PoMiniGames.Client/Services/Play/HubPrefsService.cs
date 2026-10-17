using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Services.Play;

/// <summary>
/// The hub's small memory, kept in localStorage: which games the player pinned to the top, and the
/// last game route they opened (for the "Continue" strip).
/// </summary>
/// <remarks>
/// The last route is recorded by MainLayout on every navigation, not by each game page, so every
/// catalog game is covered without a call in each one. Only routes that are a catalog mode count:
/// a demo, a lobby with a match code or any other deep link is not something to "continue".
/// </remarks>
public sealed class HubPrefsService
{
    private const string PinsKey = "pomini_hub_pins";
    private const string LastRouteKey = "pomini_last_route";

    private HashSet<string>? _pins;

    /// <summary>Is this game pinned to the top of the hub?</summary>
    public bool IsPinned(GameKey key) => Pins.Contains(key.Value);

    /// <summary>Pin or unpin a game.</summary>
    public void TogglePin(GameKey key)
    {
        if (!Pins.Remove(key.Value)) Pins.Add(key.Value);
        LocalStorageService.SetItem(PinsKey, string.Join(',', Pins.Order(StringComparer.Ordinal)));
    }

    private HashSet<string> Pins => _pins ??= new HashSet<string>(
        (LocalStorageService.GetItem<string>(PinsKey) ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries),
        StringComparer.OrdinalIgnoreCase);

    /// <summary>The last catalog mode the player opened, or null.</summary>
    public (CatalogGame Game, CatalogMode Mode)? LastPlayed =>
        LocalStorageService.GetItem<string>(LastRouteKey) is { } path ? Resolve(path) : null;

    /// <summary>Remember a navigation if it lands on a playable (non-demo) catalog mode.</summary>
    public void Record(string pathAndQuery)
    {
        if (Resolve(pathAndQuery) is not { } hit || hit.Mode.Mode == GameMode.Demo) return;
        LocalStorageService.SetItem(LastRouteKey, PathOf(hit.Mode.Url));
    }

    /// <summary>
    /// The catalog game and mode whose URL has this path (query ignored, case-insensitive), or null.
    /// </summary>
    public static (CatalogGame Game, CatalogMode Mode)? Resolve(string pathOrUrl)
    {
        var path = PathOf(pathOrUrl).TrimEnd('/');
        foreach (var game in GameCatalog.All)
        {
            foreach (var mode in game.Modes)
            {
                if (string.Equals(PathOf(mode.Url), path, StringComparison.OrdinalIgnoreCase)) return (game, mode);
            }
        }
        return null;
    }

    private static string PathOf(string url)
    {
        var q = url.IndexOfAny(['?', '#']);
        return q < 0 ? url : url[..q];
    }
}
