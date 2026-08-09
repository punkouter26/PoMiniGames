namespace PoMiniGames.Domain.Primitives;

/// <summary>
/// Server-side allowlist of the PoBrawl fighters that may appear on the demo-mode
/// Elo board, with their canonical display names.
/// </summary>
/// <remarks>
/// <para>
/// This duplicates the roster the client renders (<c>PoBrawlPage.Roster</c>) and the
/// engine simulates (<c>wwwroot/js/pobrawl/fighters.js</c> <c>CHARACTERS</c>), and it
/// duplicates it deliberately. The rating rows are keyed by fighter id, so an unvalidated
/// id is a free row-multiplier against the board — exactly the hazard
/// <see cref="T:PoMiniGames.Infrastructure.Services.HighScoreDescriptor`1"/> warns about
/// for RowKey fields. Accepting only ids that exist here keeps the partition bounded at
/// <see cref="Count"/> rows forever, no matter what a caller posts.
/// </para>
/// <para>
/// The display name is resolved here rather than taken from the request for the same
/// reason: the board must not render caller-supplied strings.
/// </para>
/// <para>
/// <b>BOB is intentionally absent.</b> He is the 1-player avatar and the 2-player pick,
/// never a demo-mode combatant (demo draws both fighters from the presidents roster), so
/// admitting him would create a permanently 0-match row on the board.
/// </para>
/// </remarks>
public static class PoBrawlRoster
{
    // Ladder order — most recent president first, marching back to FDR. The order is not
    // load-bearing here (the board ranks by rating), but it is kept identical to the
    // client roster so the two lists stay diffable by eye.
    private static readonly Dictionary<string, string> Fighters = new(StringComparer.OrdinalIgnoreCase)
    {
        ["trump"] = "Trump",
        ["biden"] = "Biden",
        ["obama"] = "Obama",
        ["bush"] = "Bush",
        ["clinton"] = "Clinton",
        ["bushsr"] = "Bush Sr.",
        ["reagan"] = "Reagan",
        ["carter"] = "Carter",
        ["ford"] = "Ford",
        ["nixon"] = "Nixon",
        ["lbj"] = "LBJ",
        ["jfk"] = "JFK",
        ["eisenhower"] = "Eisenhower",
        ["truman"] = "Truman",
        ["fdr"] = "FDR",
    };

    /// <summary>Number of rateable fighters — the hard ceiling on rows in the Elo partition.</summary>
    public static int Count => Fighters.Count;

    /// <summary>Every rateable fighter id, lowercase and canonical.</summary>
    public static IEnumerable<string> Ids => Fighters.Keys;

    /// <summary>True when <paramref name="fighterId"/> is a fighter the Elo board accepts.</summary>
    public static bool IsRateable(string? fighterId) =>
        !string.IsNullOrWhiteSpace(fighterId) && Fighters.ContainsKey(fighterId);

    /// <summary>
    /// The canonical lowercase id for a fighter, or <c>null</c> when the id is not rateable.
    /// Callers persist this, never the raw request value, so casing can never split one
    /// fighter across two rows.
    /// </summary>
    public static string? Canonicalize(string? fighterId) =>
        IsRateable(fighterId) ? fighterId!.ToLowerInvariant() : null;

    /// <summary>
    /// Display name for a fighter id. Falls back to the id itself for a row written by an
    /// older build whose roster has since changed — a stale row should still render.
    /// </summary>
    public static string DisplayName(string fighterId) =>
        Fighters.TryGetValue(fighterId, out var name) ? name : fighterId;
}
