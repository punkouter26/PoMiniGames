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
/// legacy <c>"1"</c> demo segment; PoMarbleRace / PoCoupleQuiz did
/// not.</item>
/// <item>Two different legacy query forms were in use for the same intent —
/// <c>?mode=2p</c> in one half of the catalog and <c>?demo=1</c> in the other —
/// and no page accepted both.</item>
/// </list>
/// <para>
/// The surviving legacy forms are accepted here, case-insensitively, so old bookmarks
/// keep working uniformly instead of per-game. New links should use the canonical slugs
/// from <see cref="ToSlug"/>.
/// </para>
/// <para>
/// The <c>"multiplayer"</c> and <c>"lobby"</c> segments were dropped on 2026-09-11 with
/// the five duplicate <c>@page</c> aliases that produced them (<c>/funquiz/multiplayer</c>,
/// <c>/{couplequiz,poracer,posports,povoxelstrike}/lobby</c>). Each of those pages still
/// answers on its canonical <c>/{game}/multi</c>. Keeping the words here would have been
/// worse than dropping them: with the alias routes gone, the three games that also declare
/// a <c>/{game}/{Mode}</c> catch-all would have swallowed the stale URL and parsed it as
/// Multiplayer on a page that cannot host it. Unrecognised now means OnePlayer, which is
/// exactly what the contract below promises.
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

        if (IsAny(routeSegment, MultiplayerSlug)) return GameMode.Multiplayer;

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

    /// <summary>
    /// Long-form mode name for a page heading (<c>Connect Five · 2 Players</c>).
    /// </summary>
    /// <remarks>
    /// Distinct from <see cref="ToLabel"/>, which is the terse chip on the home card
    /// ("2P") and is sized for a chip, not a title. Every game title should compose
    /// through this so the mode is readable in the top bar: a heading that names the
    /// game but not the mode cannot tell a player which of the three Connect Five
    /// routes a shared link dropped them into. It exists because the pages had started
    /// inventing their own headings — "Voxel Strike · Co-op", "PoEcosystem · A living
    /// island" — which left twelve of sixteen games with no mode in the title at all.
    /// </remarks>
    public static string ToHeading(GameMode mode) => mode switch
    {
        GameMode.TwoPlayer => "2 Players",
        GameMode.Multiplayer => "Multiplayer",
        GameMode.Demo => "Demo",
        _ => "1 Player",
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
