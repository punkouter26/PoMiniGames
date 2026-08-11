using PoMiniGames.Shared.Games.PoJoker;

namespace PoMiniGames.Features.PoJoker.Storage;

/// <summary>
/// Reduces raw joke-performance rows to the "best jokes" board.
/// </summary>
/// <remarks>
/// Split out of <see cref="JokeStorageClient"/> so the ranking rules are pure: no table client,
/// no async, no Azurite. Everything here is a decision that can be silently wrong — which score
/// counts, which rows are eligible, how duplicates collapse — and each is cheap to assert once
/// it is separated from the scan that feeds it.
/// </remarks>
public static class TopJokeRanking
{
    /// <summary>
    /// Rank performance rows into a board: eligible rows only, one row per joke id carrying its
    /// best score, highest first, capped at <paramref name="top"/>.
    /// </summary>
    public static IReadOnlyList<TopJokeDto> Rank(IEnumerable<JokePerformanceEntity> rows, int top)
    {
        var bestByJoke = new Dictionary<string, TopJokeDto>(StringComparer.Ordinal);

        foreach (var entity in rows)
        {
            if (!IsEligible(entity)) continue;

            var score = Score(entity);
            var key = DedupKey(entity);

            // Keep the highest-scoring telling of each joke. The same joke is drawn for many
            // sessions and rated a little differently each time; without this collapse one
            // popular joke fills the whole board.
            if (bestByJoke.TryGetValue(key, out var existing) && existing.Score >= score)
                continue;

            bestByJoke[key] = new TopJokeDto
            {
                JokeId = entity.JokeId,
                Setup = SetupOf(entity),
                Punchline = entity.JokeType == "twopart" ? entity.JokePunchline : string.Empty,
                Score = Math.Round(score, 2),
            };
        }

        return bestByJoke.Values
            .OrderByDescending(j => j.Score)
            // Deterministic tiebreak. Dictionary order is not guaranteed, so without this two
            // equally-rated jokes can swap places between requests — a board that reshuffles on
            // refresh reads as broken.
            .ThenBy(j => j.JokeId)
            .Take(top)
            .ToList();
    }

    /// <summary>
    /// The joke's score: the mean of the three dimensions the LLM is actually asked for.
    /// </summary>
    /// <remarks>
    /// Humour is stored in <c>RatingDifficulty</c> and originality in <c>RatingComplexity</c> —
    /// the prompt asks for originality/cleverness/humor and the results are written to legacy
    /// field names for row compatibility (see <c>AiJesterService.RateJokeUncachedAsync</c>).
    ///
    /// Deliberately not <c>RatingAverage</c>: that divides by four to fold in <c>Rudeness</c>,
    /// which is hardcoded to 1 for every joke, so it shifts every score by the same constant
    /// while adding no ranking signal.
    /// </remarks>
    public static double Score(JokePerformanceEntity e) =>
        (e.RatingDifficulty + e.RatingCleverness + e.RatingComplexity) / 3.0;

    /// <summary>Whether a row may appear on the public board at all.</summary>
    public static bool IsEligible(JokePerformanceEntity e)
    {
        // Rows written before rating existed, or whose rating call failed, persist as all-zero.
        // They are UNRATED, not zero-rated, and must not occupy a slot.
        if (e.RatingCleverness <= 0 && e.RatingComplexity <= 0 && e.RatingDifficulty <= 0)
            return false;

        // This is the one board whose rows are content rather than a score against a name, and
        // it is anonymous-readable. Flagged material is dropped here rather than at render time:
        // the flags are already on the row, and a board that can publish a slur because the
        // model happened to rate it highly is not worth the three rows it fills. Jokes fetched
        // in safe mode carry no flags and pass through untouched.
        if (e.FlagNsfw || e.FlagRacist || e.FlagSexist || e.FlagExplicit)
            return false;

        return !string.IsNullOrWhiteSpace(SetupOf(e));
    }

    /// <summary>Setup line for a two-part joke, or the whole text for a one-liner.</summary>
    private static string SetupOf(JokePerformanceEntity e) =>
        e.JokeType == "twopart" ? e.JokeSetup : e.JokeText;

    /// <summary>
    /// The identity two rows must share to count as the same joke: the normalised setup.
    /// </summary>
    /// <remarks>
    /// NOT <c>JokeId</c>, which is the obvious choice and does not work. Observed on a real
    /// board: "Why do programmers prefer dark mode?" occupied ranks 1, 3 and 4 simultaneously,
    /// each row carrying a different id. The same joke reaches storage under more than one id —
    /// it is re-fetched from JokeAPI across sessions, the sanitiser rewrites flagged text before
    /// it is stored, and the canned fallback writes id 0 — so an id-keyed dedup collapses none
    /// of them.
    ///
    /// Keying on the setup is also the right granularity for what this board renders: the row
    /// shows the setup, so two rows with the same setup are visibly duplicate whatever their ids
    /// say. Case- and whitespace-insensitive because the sanitiser's rewrites differ in exactly
    /// those ways.
    /// </remarks>
    private static string DedupKey(JokePerformanceEntity e)
    {
        var setup = SetupOf(e);
        var sb = new System.Text.StringBuilder(setup.Length);
        var lastWasSpace = false;
        foreach (var ch in setup)
        {
            if (char.IsWhiteSpace(ch))
            {
                if (sb.Length > 0 && !lastWasSpace) { sb.Append(' '); lastWasSpace = true; }
                continue;
            }
            // Drop punctuation so a trailing "?" or a smart vs straight apostrophe does not
            // split one joke into two rows.
            if (char.IsPunctuation(ch) || char.IsSymbol(ch)) continue;
            sb.Append(char.ToLowerInvariant(ch));
            lastWasSpace = false;
        }
        return sb.ToString().TrimEnd();
    }
}
