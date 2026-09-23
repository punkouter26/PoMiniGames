namespace PoMiniGamesClient.Games.PoBrawl;

/// <summary>
/// One fighter's "tale of the tape" — the boxing weigh-in card the 1P intro shows next to
/// the scouting report.
/// </summary>
/// <param name="Term">Years in office, as a weigh-in card would print a record.</param>
/// <param name="Party">Party at the time of office.</param>
/// <param name="Height">Commonly cited height.</param>
/// <param name="Born">Birth year and state.</param>
/// <param name="Quote">A famous line, verbatim (a slogan where that is what they are known for).</param>
/// <param name="WikiTitle">
/// English Wikipedia page title, used only to fetch the portrait thumbnail
/// (<c>wwwroot/js/pobrawlTape.js</c>). <c>null</c> for BOB, who has no page.
/// </param>
public sealed record PoBrawlTapeEntry(
    string Term, string Party, string Height, string Born, string Quote, string? WikiTitle);

/// <summary>
/// Static facts for the tale-of-the-tape card, keyed by the <see cref="PoMiniGames.Domain.Primitives.PoBrawlRoster"/> ids.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why the facts are curated here and only the portrait is fetched.</b> Wikipedia's summary
/// endpoint returns a portrait, a one-line description and an extract — none of it in the
/// fixed shape a weigh-in card needs (term, party, height, birthplace), and parsing those out
/// of prose would be fragile. The five facts per president are settled history, so they live
/// in code; the portrait is the part worth fetching live, and the card stands without it when
/// the fetch fails or the device is offline.
/// </para>
/// <para>
/// A missing id is not an error: <see cref="For"/> answers <c>null</c> and the intro simply omits
/// the card, the same contract as <see cref="PoBrawlDossier"/>.
/// </para>
/// </remarks>
public static class PoBrawlTape
{
    private static readonly Dictionary<string, PoBrawlTapeEntry> Entries = new(StringComparer.OrdinalIgnoreCase)
    {
        // BOB is the player's avatar, not a president — his column is the joke corner.
        ["bob"] = new("Today only", "Independent", "5′11″", "The lobby", "I just work here.", null),
        ["trump"] = new("2017–21 · 2025–", "Republican", "6′3″", "1946 · New York", "Make America great again.", "Donald_Trump"),
        ["biden"] = new("2021–25", "Democratic", "6′0″", "1942 · Pennsylvania", "Here's the deal.", "Joe_Biden"),
        ["obama"] = new("2009–17", "Democratic", "6′1″", "1961 · Hawaii", "Yes, we can.", "Barack_Obama"),
        ["bush"] = new("2001–09", "Republican", "6′0″", "1946 · Connecticut", "I'm the decider.", "George_W._Bush"),
        ["clinton"] = new("1993–2001", "Democratic", "6′2″", "1946 · Arkansas", "I feel your pain.", "Bill_Clinton"),
        ["bushsr"] = new("1989–93", "Republican", "6′2″", "1924 · Massachusetts", "Read my lips: no new taxes.", "George_H._W._Bush"),
        ["reagan"] = new("1981–89", "Republican", "6′1″", "1911 · Illinois", "Mr. Gorbachev, tear down this wall!", "Ronald_Reagan"),
        ["carter"] = new("1977–81", "Democratic", "5′9½″", "1924 · Georgia", "It is a crisis of confidence.", "Jimmy_Carter"),
        ["ford"] = new("1974–77", "Republican", "6′0″", "1913 · Nebraska", "Our long national nightmare is over.", "Gerald_Ford"),
        ["nixon"] = new("1969–74", "Republican", "5′11½″", "1913 · California", "I am not a crook.", "Richard_Nixon"),
        ["lbj"] = new("1963–69", "Democratic", "6′3½″", "1908 · Texas", "All the way with LBJ.", "Lyndon_B._Johnson"),
        ["jfk"] = new("1961–63", "Democratic", "6′0½″", "1917 · Massachusetts", "Ask not what your country can do for you.", "John_F._Kennedy"),
        ["eisenhower"] = new("1953–61", "Republican", "5′10½″", "1890 · Texas", "Plans are worthless, but planning is everything.", "Dwight_D._Eisenhower"),
        ["truman"] = new("1945–53", "Democratic", "5′9″", "1884 · Missouri", "The buck stops here.", "Harry_S._Truman"),
        ["fdr"] = new("1933–45", "Democratic", "6′2″", "1882 · New York", "The only thing we have to fear is fear itself.", "Franklin_D._Roosevelt"),
    };

    /// <summary>The card for <paramref name="fighterId"/>, or <c>null</c> when there is none.</summary>
    public static PoBrawlTapeEntry? For(string? fighterId) =>
        fighterId is not null && Entries.TryGetValue(fighterId, out var entry) ? entry : null;
}

/// <summary>
/// The live half of the card, from Wikipedia's page-summary endpoint via
/// <c>wwwroot/js/pobrawlTape.js</c>. Bound camelCase by the interop serializer.
/// </summary>
/// <param name="Thumbnail">Portrait URL on a Wikimedia media host (thumb. / upload.wikimedia.org), or empty.</param>
/// <param name="Description">Wikipedia's one-line description (used as the image title).</param>
public sealed record PoBrawlTapeWiki(string Thumbnail, string Description);
