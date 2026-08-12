using PoMiniGames.Domain.Primitives;

namespace PoMiniGamesClient.Games.PoBrawl;

/// <summary>
/// Player-facing scouting copy for one fighter: what their signature super does, and the
/// visual tell that says an attack is coming.
/// </summary>
/// <param name="SuperName">The super's in-fiction name, as the engine's flavour comments call it.</param>
/// <param name="SuperEffect">What the signature move does when it fires, in one line. (It fires
/// itself now — there is no super key — so this reads as a warning, not an instruction.)</param>
/// <param name="Tell">
/// The opening beat of this president's signature phrase (personalities.js <c>aiPattern</c>) and
/// the lesson it teaches. Deliberately names the TELL and the counter without listing the whole
/// script: the phrase is fixed and repeats all fight, so a player who is given the first beat can
/// still discover what follows by fighting it. Spelling out every step would remove the discovery
/// this card exists to seed.
/// </param>
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
/// an error — <see cref="For"/> answers <c>null</c> and the intro card simply omits the panel.
/// BOB is deliberately absent and must stay that way: he is the generic avatar the fifteen
/// presidents are characterised against, with no personality profile and no signature super,
/// so there is nothing to scout. Adding an entry for him would promise a move he does not have.
/// </para>
/// </remarks>
public static class PoBrawlDossier
{
    private static readonly Dictionary<string, PoBrawlDossierEntry> ById =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["trump"] = new("THE WALL",
                "Banks every knockdown he's taken into one short window where every swing hits far harder.",
                "Two quick jabs, then he loads up. It's the third swing in the string that hurts."),
            ["biden"] = new("THE BIG GUY",
                "Skips the wind-up: his next strike lands fully charged and slows you on impact.",
                "He goes still for a beat, then winds the longest charge on the roster. That pause is your block cue."),
            ["obama"] = new("DRONE STRIKE",
                "A moment of untouchable frames, then one surgical swing at multiplied damage.",
                "Circles out before he commits, then strikes from the new angle. He also leans out of a fifth of your attacks."),
            ["bush"] = new("DECIDER MODE",
                "Commits to a permanent damage-and-speed buff for the rest of the round.",
                "He stops dead to decide — the longest pause on the roster. Punish it and the quick two-hit answer never comes."),
            ["clinton"] = new("SAX SOLO",
                "Arms an amplified swing that automatically chains into a flurry of follow-ups.",
                "Watch the sway. He rocks side to side before the big one, and his wind-up is longer than anyone's."),
            ["bushsr"] = new("VOODOO ECONOMICS",
                "A burst of guaranteed feints, then several swings that all carry bonus damage.",
                "His opening jab is bait — he wants you to swing back. The guard behind it is where the counter comes from."),
            ["reagan"] = new("MORNING IN AMERICA",
                "Bigger damage and faster movement for several seconds.",
                "He plants and waits, daring you to hit the guard. Once a round that guard reflects your damage back."),
            ["carter"] = new("MALAISE SPEECH",
                "Untouchable frames, and his next landed hit slows you down.",
                "A ladder of jabs, each faster than the last. Break the rhythm early or it keeps growing."),
            ["ford"] = new("PARDON ME",
                "Blinds your controls for a second — most of your inputs simply drop.",
                "He barges in and swings wild from too close. The lurch is a free window — step out instead of trading."),
            ["nixon"] = new("I AM NOT A CROOK",
                "His next few swings cut through your block, and the first one blinds you.",
                "He breaks off like he's disengaging, then comes straight back. Don't chase — that's the trap."),
            ["lbj"] = new("THE TREATMENT",
                "Opens a long window where any whiff of yours arms his next swing with huge knockback.",
                "He walks you down without guarding or swinging. Backing out beats it; panicking into a swing feeds him."),
            ["jfk"] = new("PROFILES IN COURAGE",
                "Untouchable frames followed by a heavily amplified swing.",
                "The fastest opener on the roster — he steps around and is on you before you've turned. Every fourth hit is a crowning blow."),
            ["eisenhower"] = new("OPERATION OVERLORD",
                "The biggest single swing any president can buy, plus untouchable frames.",
                "The longest preparation in the game: guard, then an enormous coil. Block it and the punish is enormous too."),
            ["truman"] = new("THE BUCK STOPS HERE",
                "Cashes everything he's absorbed this fight into one enormous swing.",
                "He walks in with his hands down and lets you hit him. Every hit you land makes his answer bigger — stop swinging."),
            ["fdr"] = new("DAY OF INFAMY",
                "A long stretch of elevated damage, with no health condition to wait for.",
                "He settles and pauses to address the room. Swing into the pause and you hit nothing — and the kick after it reaches further than it should."),
        };

    /// <summary>The scouting report for a fighter, or <c>null</c> when there is none (BOB).</summary>
    public static PoBrawlDossierEntry? For(string? fighterId) =>
        !string.IsNullOrWhiteSpace(fighterId) && ById.TryGetValue(fighterId, out var e) ? e : null;
}
