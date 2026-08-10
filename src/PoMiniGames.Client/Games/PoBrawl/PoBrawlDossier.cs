using PoMiniGames.Domain.Primitives;

namespace PoMiniGamesClient.Games.PoBrawl;

/// <summary>
/// Player-facing scouting copy for one fighter: what their signature super does, and the
/// visual tell that says an attack is coming.
/// </summary>
/// <param name="SuperName">The super's in-fiction name, as the engine's flavour comments call it.</param>
/// <param name="SuperEffect">What pressing the super key actually buys, in one line.</param>
/// <param name="Tell">The thing to watch for — the read that turns the fight into a puzzle.</param>
public sealed record PoBrawlDossierEntry(string SuperName, string SuperEffect, string Tell);

/// <summary>
/// The "know your opponent" table behind the intro card's scouting panel.
/// </summary>
/// <remarks>
/// <para>
/// <b>This is prose, not a second copy of the engine's data.</b> The numbers that decide a
/// fight live in <c>wwwroot/js/pobrawl/personalities.js</c> and are the only authority on
/// behaviour; nothing here is read by the simulation. Restating the multipliers and durations
/// would create a second source of truth that silently goes stale on the first balance tweak,
/// so each line describes the SHAPE of the move ("the biggest single swing in the game")
/// rather than its coefficients. Retuning a super does not require touching this file; giving
/// a president a different super does.
/// </para>
/// <para>
/// Keyed by the same lowercase fighter ids as <see cref="PoBrawlRoster"/>. A missing id is not
/// an error — <see cref="For"/> answers <c>null</c> and the intro card simply omits the panel,
/// which is the right behaviour for BOB (the player avatar has no scouting report to show).
/// </para>
/// </remarks>
public static class PoBrawlDossier
{
    private static readonly Dictionary<string, PoBrawlDossierEntry> ById =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["trump"] = new("THE WALL",
                "Banks every knockdown he's taken into one short window where every swing hits far harder.",
                "Throws far more swings than anyone else — roughly one in five is a committed haymaker."),
            ["biden"] = new("THE BIG GUY",
                "Skips the wind-up: his next strike lands fully charged and slows you on impact.",
                "Winds up a long telegraphed charge every few seconds. That is your block cue."),
            ["obama"] = new("DRONE STRIKE",
                "A moment of untouchable frames, then one surgical swing at multiplied damage.",
                "Counter-puncher. He leans out of attacks about a fifth of the time — bait, don't spam."),
            ["bush"] = new("DECIDER MODE",
                "Commits to a permanent damage-and-speed buff for the rest of the round.",
                "Below 40% health he freezes to 'decide', then comes back faster and harder."),
            ["clinton"] = new("SAX SOLO",
                "Arms an amplified swing that automatically chains into a flurry of follow-ups.",
                "His wind-up is noticeably longer than everyone else's — the sway before the solo."),
            ["bushsr"] = new("VOODOO ECONOMICS",
                "A burst of guaranteed feints, then several swings that all carry bonus damage.",
                "The best block-punisher on the roster. A third of his wind-ups are fakes."),
            ["reagan"] = new("MORNING IN AMERICA",
                "Bigger damage and faster movement for several seconds, on demand.",
                "Once a round he plants a guard that reflects part of your damage back at you."),
            ["carter"] = new("MALAISE SPEECH",
                "Untouchable frames, and his next landed hit slows you down.",
                "Each hit he lands extends his next string — break the rhythm or it grows."),
            ["ford"] = new("PARDON ME",
                "Blinds your controls for a second — most of your inputs simply drop.",
                "He trips over himself on some swings. Punishing the stumble arms his counter-window."),
            ["nixon"] = new("I AM NOT A CROOK",
                "His next few swings cut through your block, and the first one blinds you.",
                "A quarter of his attacks already ignore much of your guard. Blocking is not enough."),
            ["lbj"] = new("THE TREATMENT",
                "Opens a long window where any whiff of yours arms his next swing with huge knockback.",
                "He feeds on your misses. Whiffing a charged swing near him is the real mistake."),
            ["jfk"] = new("PROFILES IN COURAGE",
                "Untouchable frames followed by a heavily amplified swing.",
                "Every fourth hit he lands is a crowning blow. Count them."),
            ["eisenhower"] = new("OPERATION OVERLORD",
                "The biggest single swing any president can buy, plus untouchable frames.",
                "Long wind-up, short active window — block it and the punish is enormous."),
            ["truman"] = new("THE BUCK STOPS HERE",
                "Cashes everything he's absorbed this fight into one enormous swing.",
                "The longer he's been taking punishment, the more his next hit is worth. Don't let him bank."),
            ["fdr"] = new("DAY OF INFAMY",
                "A long stretch of elevated damage, with no health condition to wait for.",
                "Opens every round already warmed up, and slips brief untouchable frames in on a cycle."),
        };

    /// <summary>The scouting report for a fighter, or <c>null</c> when there is none (BOB).</summary>
    public static PoBrawlDossierEntry? For(string? fighterId) =>
        !string.IsNullOrWhiteSpace(fighterId) && ById.TryGetValue(fighterId, out var e) ? e : null;
}
