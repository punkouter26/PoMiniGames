namespace PoMiniGamesClient.Models;

/// <summary>
/// The four ways any game in the catalog can be played. This is the canonical
/// vocabulary — the route segment, the home-page chip, and each page's internal
/// branching all resolve through <see cref="GameModes.Parse"/>.
/// </summary>
public enum GameMode
{
    /// <summary>Solo against the CPU. The default when a route carries no mode.</summary>
    OnePlayer,

    /// <summary>Two players sharing one device/keyboard.</summary>
    TwoPlayer,

    /// <summary>Hub-backed online play. Always requires a live server.</summary>
    Multiplayer,

    /// <summary>Unattended attract-mode playback (the kiosk reel).</summary>
    Demo,
}

/// <summary>
/// One parser for the <c>/{game}/{mode}</c> route segment and its legacy query-string
/// forms.
/// </summary>
/// <remarks>
/// <para>
/// This exists because every game page used to re-implement the parse, and they
/// disagreed in ways that silently changed behaviour per game:
/// </para>
/// <list type="bullet">
/// <item><c>Mode is "demo" or "1"</c> is an <b>ordinal</b> pattern match, so
/// <c>/connectfive/DEMO</c> did not start a demo — while the sibling check for
/// <c>"2player"</c> on the very next line used <c>OrdinalIgnoreCase</c> and did
/// match <c>/connectfive/2PLAYER</c>. Case sensitivity varied within a single
/// method.</item>
/// <item>ConnectFive / TicTacToe / PoBrawl / PoSports / PoFunQuiz accepted the
/// legacy <c>"1"</c> demo segment; PoMarbleRace / PoCoupleQuiz / PoSurvive did
/// not.</item>
/// <item>Two different legacy query forms were in use for the same intent —
/// <c>?mode=2p</c> in one half of the catalog and <c>?demo=1</c> in the other —
/// and no page accepted both.</item>
/// </list>
/// <para>
/// Every legacy form is accepted here, case-insensitively, so old bookmarks keep
/// working uniformly instead of per-game. New links should use the canonical
/// slugs from <see cref="ToSlug"/>.
/// </para>
/// </remarks>
public static class GameModes
{
    public const string OnePlayerSlug = "1player";
    public const string TwoPlayerSlug = "2player";
    public const string MultiplayerSlug = "multi";
    public const string DemoSlug = "demo";

    /// <summary>
    /// Resolve the effective mode from a route segment plus the two legacy query
    /// parameters. Anything unrecognised — including null, empty, or a segment
    /// written by a build older than the uniform scheme — reads as
    /// <see cref="GameMode.OnePlayer"/>, which is the safe default: it is the
    /// only mode that is playable for every game and never auto-starts.
    /// </summary>
    /// <param name="routeSegment">The <c>{Mode}</c> route parameter.</param>
    /// <param name="modeQuery">Legacy <c>?mode=</c> value (<c>2p</c>, <c>2ps</c>).</param>
    /// <param name="demoQuery">Legacy <c>?demo=1</c> value.</param>
    public static GameMode Parse(string? routeSegment, string? modeQuery = null, int demoQuery = 0)
    {
        // Demo wins over everything: the kiosk reel appends its own mode and an
        // attract screen must never fall through to an interactive mode that
        // waits on a keypress nobody is there to press.
        if (demoQuery == 1 || IsAny(routeSegment, DemoSlug, "1")) return GameMode.Demo;

        if (IsAny(routeSegment, TwoPlayerSlug, "2p", "2ps") ||
            IsAny(modeQuery, "2p", "2ps")) return GameMode.TwoPlayer;

        if (IsAny(routeSegment, MultiplayerSlug, "multiplayer", "lobby")) return GameMode.Multiplayer;

        return GameMode.OnePlayer;
    }

    /// <summary>
    /// True when the caller asked specifically for the split-screen flavour of
    /// two-player (PoFunQuiz's <c>2ps</c>). A sub-variant of
    /// <see cref="GameMode.TwoPlayer"/> rather than a mode of its own — only one
    /// game implements it, so it does not earn a slot in the shared enum.
    /// </summary>
    public static bool IsSplitScreen(string? routeSegment, string? modeQuery) =>
        IsAny(routeSegment, "2ps") || IsAny(modeQuery, "2ps");

    /// <summary>The canonical URL segment for a mode.</summary>
    public static string ToSlug(GameMode mode) => mode switch
    {
        GameMode.TwoPlayer => TwoPlayerSlug,
        GameMode.Multiplayer => MultiplayerSlug,
        GameMode.Demo => DemoSlug,
        _ => OnePlayerSlug,
    };

    /// <summary>Short label for the mode chip on the home page.</summary>
    public static string ToLabel(GameMode mode) => mode switch
    {
        GameMode.TwoPlayer => "2P",
        GameMode.Multiplayer => "Online",
        GameMode.Demo => "Demo",
        _ => "1P",
    };

    /// <summary>Accessible name for the mode chip; the short label alone is not one.</summary>
    public static string ToDescription(GameMode mode) => mode switch
    {
        GameMode.TwoPlayer => "2 players, one device",
        GameMode.Multiplayer => "Online multiplayer",
        GameMode.Demo => "Watch a demo",
        _ => "1 player vs CPU",
    };

    private static bool IsAny(string? value, params string[] candidates)
    {
        if (string.IsNullOrWhiteSpace(value)) return false;
        foreach (var candidate in candidates)
        {
            if (string.Equals(value, candidate, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }
}
