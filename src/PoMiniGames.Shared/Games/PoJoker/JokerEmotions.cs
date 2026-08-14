namespace PoMiniGames.Shared.Games.PoJoker;

/// <summary>
/// The audience portrait vocabulary: one slug per Grandma reaction shot shipped under
/// <c>wwwroot/images/PoJoker/grandma-&lt;slug&gt;.webp</c>.
/// </summary>
/// <remarks>
/// <para>
/// This list is the contract between three places that must not drift: the JSON schema the
/// rating model answers against (<c>AiJesterService.RatingSchema</c>), the file names on disk,
/// and the client's <c>AudienceReaction</c> component. All three read it from here rather than
/// repeating a literal — a slug present in the schema but missing on disk is a broken image in
/// the middle of a show, and the model has no way to know it guessed a name nothing renders.
/// </para>
/// <para>
/// Slugs, not an enum. The value crosses the wire from a language model, so it must survive
/// arriving misspelled, cased differently, or simply invented; <see cref="Normalize"/> collapses
/// all of that to <see cref="Neutral"/>. An enum would either throw on deserialize or silently
/// land on whichever member happens to be 0.
/// </para>
/// </remarks>
public static class JokerEmotions
{
    /// <summary>The fallback reaction: unconfigured AI, an unreadable rating, or an unknown slug.</summary>
    public const string Neutral = "neutral";

    /// <summary>Shown while the Jester is still reading the setup.</summary>
    public const string Thinking = "thinking";

    /// <summary>Shown while the Jester is committing to a guess.</summary>
    public const string Concentrating = "concentrating";

    /// <summary>
    /// Every portrait on disk, in the order the model sees them. Kept as an array (not a
    /// HashSet) because it is enumerated into a JSON schema enum far more often than it is
    /// searched; <see cref="Normalize"/> does the lookup against <see cref="Lookup"/>.
    /// </summary>
    public static readonly string[] All =
    [
        "anger",
        "anticipation",
        "blushing",
        Concentrating,
        "confused",
        "disgust",
        "drunk",
        "dying",
        "eye-roll",
        "fear",
        "joy",
        Neutral,
        "sadness",
        "smug",
        "stealthy",
        "surprise",
        "suspicious",
        Thinking,
        "trust",
        "unconscious",
        "wounded",
    ];

    private static readonly HashSet<string> Lookup = new(All, StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// The named portrait, or <see cref="Neutral"/> when the name is absent, blank or not one
    /// this game ships. Never returns a slug without a file behind it.
    /// </summary>
    public static string Normalize(string? emotion)
    {
        if (string.IsNullOrWhiteSpace(emotion))
            return Neutral;

        var trimmed = emotion.Trim();
        return Lookup.TryGetValue(trimmed, out var canonical) ? canonical : Neutral;
    }

    /// <summary>The web path of a portrait. Assumes an already-normalized slug.</summary>
    public static string ImagePath(string emotion) => $"images/PoJoker/grandma-{emotion}.webp";
}
