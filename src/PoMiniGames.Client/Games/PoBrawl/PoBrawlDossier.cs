using PoMiniGames.Domain.Primitives;

namespace PoMiniGamesClient.Games.PoBrawl;

/// <summary>
/// Player-facing scouting copy for one fighter: what their signature super does, the visual
/// tell that says an attack is coming, and the footwork they circle on between attacks.
/// </summary>
/// <param name="SuperName">The super's in-fiction name, as the engine's flavour comments call it.</param>
/// <param name="SuperEffect">What the signature move does when it fires, in one line. (It fires
/// itself now — there is no super key — so this reads as a warning, not an instruction.)</param>
/// <param name="Tell">
/// The opening beat of this president's signature phrase (personalities.js <c>aiPatterns</c>) and
/// the lesson it teaches. Deliberately names the TELL and the counter without listing the whole
/// script: the phrases are fixed and repeat all fight, so a player who is given the first beat can
/// still discover what follows by fighting it. Spelling out every step would remove the discovery
/// this card exists to seed.
/// <para>
/// Each president owns three phrases, and the rung decides how many are in play (ai.js
/// <c>_unlockedPatterns</c>: rungs 1-3 run one, 4-9 alternate two, 10-15 cycle all three).
/// Because a president sits at exactly one rung of the ladder, that mapping is fixed per
/// fighter — Trump is always a one-phrase fight, FDR is always a three-phrase one — so the
/// back half of the roster gets a sentence warning that the read they just learned is not the
/// whole fighter. Naming the COUNT is the useful part; naming the phrases is not.
/// </para>
/// </param>
/// <param name="Footwork">
/// The president's neutral-game dance (personalities.js <c>footwork</c>): the fixed cycle of
/// steps and orbits he circles on when he is not committed to a phrase, which is most of the
/// round. Named here because unlike the phrases it is running the whole time and is therefore
/// the read a player will actually get to practise — and because the cycle never resets, so
/// timing a swing into a beat of it works the same way in the last ten seconds of the round as
/// the first. Same rule as <paramref name="Tell"/>: describe the shape and what it costs him,
/// never the beat lengths, which are the engine's to retune.
/// </param>
public sealed record PoBrawlDossierEntry(
    string SuperName, string SuperEffect, string Tell, string Footwork);

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
                "Two quick jabs, then he loads up. It's the third swing in the string that hurts.",
                "He never gives ground. Two strides and a squared-up beat, on repeat — back up and he simply walks you into the ropes."),
            ["biden"] = new("THE BIG GUY",
                "Skips the wind-up: his next strike lands fully charged and slows you on impact.",
                "He goes still for a beat, then winds the longest charge on the roster. That pause is your block cue.",
                "Short step in, long settle, small step out. The settle is the same beat his charge opens on, so his feet give away the coil."),
            ["obama"] = new("DRONE STRIKE",
                "A moment of untouchable frames, then one surgical swing at multiplied damage.",
                "Circles out before he commits, then strikes from the new angle. He also leans out of a fifth of your attacks.",
                "He orbits, always the same way, closing in arcs rather than lines. Cut the ring off on that side and his angles stop working."),
            ["bush"] = new("DECIDER MODE",
                "Commits to a permanent damage-and-speed buff for the rest of the round.",
                "He stops dead to decide — the longest pause on the roster. Punish it and the quick two-hit answer never comes. He has a second string that skips the pause entirely.",
                "In, stop dead, in, stop dead. Both stops are free; the second is long enough to walk into and load up on."),
            ["clinton"] = new("SAX SOLO",
                "Arms an amplified swing that automatically chains into a flurry of follow-ups.",
                "Watch the sway. He rocks side to side before the big one, and his wind-up is longer than anyone's. There's a second string behind it that opens on the other foot.",
                "The sway never stops — four beats through both directions while he barely closes. With Clinton the feet are the tell and the string is the punchline."),
            ["bushsr"] = new("VOODOO ECONOMICS",
                "A burst of guaranteed feints, then several swings that all carry bonus damage.",
                "His opening jab is bait — he wants you to swing back. The guard behind it is where the counter comes from. He has a second string that opens on the guard instead.",
                "He steps to the edge of range and straight back out of it. A range-finder — which is why his counter always arrives from exactly where your jab falls short."),
            ["reagan"] = new("MORNING IN AMERICA",
                "Bigger damage and faster movement for several seconds.",
                "He plants and waits, daring you to hit the guard — once a round it reflects your damage back. He also has a string with no guard in it at all.",
                "Long stretches of standing perfectly still, broken by one stride. Standing is his whole game and his feet advertise it."),
            ["carter"] = new("MALAISE SPEECH",
                "Untouchable frames, and his next landed hit slows you down.",
                "A ladder of jabs, each faster than the last. Break the rhythm early or it keeps growing — and he has a second ladder that mixes in kicks your guard won't catch.",
                "In, out, in, out, on a flat half-second beat and nothing else. The most countable feet on the roster — and the jab ladder rides that same tempo."),
            ["ford"] = new("PARDON ME",
                "Blinds your controls for a second — most of your inputs simply drop.",
                "He barges in and swings wild from too close. The lurch is a free window — step out instead of trading. His other approach ends in a coil, so read which one you got.",
                "One long overshooting stride, a beat of nothing, then a drift back out. He arrives closer than he meant to every single time."),
            ["nixon"] = new("I AM NOT A CROOK",
                "His next few swings cut through your block, and the first one blinds you.",
                "He breaks off like he's disengaging, then comes straight back. Don't chase — that's the trap. He rotates three strings, and the other two open on a sidestep and a silence.",
                "He creeps in sideways, breaks off, then resets on the other side. The break in his footwork is the same trap the string is built on."),
            ["lbj"] = new("THE TREATMENT",
                "Opens a long window where any whiff of yours arms his next swing with huge knockback.",
                "He walks you down without guarding or swinging. Backing out beats it; panicking into a swing feeds him. Three different strings and the heaviest coil on the ladder — expect all of them.",
                "Nine-tenths forward pressure with two short leans, and not one backward step. Walk away from these feet; do not swing at them."),
            ["jfk"] = new("PROFILES IN COURAGE",
                "Untouchable frames followed by a heavily amplified swing.",
                "The fastest opener on the roster — he steps around and is on you before you've turned. Every fourth hit is a crowning blow, and he rotates three strings, so the angle changes every time.",
                "The quickest cycle on the ladder: short darts on alternating angles, changing the side he's standing on about twice a second."),
            ["eisenhower"] = new("OPERATION OVERLORD",
                "The biggest single swing any president can buy, plus untouchable frames.",
                "The longest preparation in the game: guard, then an enormous coil. Block it and the punish is enormous too — but two of his three strings are coils, and one hides a guard between them.",
                "Slow, deliberate, and every yard he takes he keeps. The longest single forward stride on the roster, from the slowest hands."),
            ["truman"] = new("THE BUCK STOPS HERE",
                "Cashes everything he's absorbed this fight into one enormous swing.",
                "He walks in with his hands down and lets you hit him. Every hit you land makes his answer bigger — stop swinging. All three of his strings end on a coil that is priced by what you fed him.",
                "Straight in, no angle, no retreat. The simplest feet in the game and the most expensive to answer — the walk-in is the bait."),
            ["fdr"] = new("DAY OF INFAMY",
                "A long stretch of elevated damage, with no health condition to wait for.",
                "He settles and pauses to address the room. Swing into the pause and you hit nothing — and the kick after it reaches further than it should. Two more strings behind that one, one of them barely telegraphed.",
                "He holds the centre and turns you around it, both ways, closing only in bursts. He is the one president who makes you do the travelling."),
        };

    /// <summary>The scouting report for a fighter, or <c>null</c> when there is none (BOB).</summary>
    public static PoBrawlDossierEntry? For(string? fighterId) =>
        !string.IsNullOrWhiteSpace(fighterId) && ById.TryGetValue(fighterId, out var e) ? e : null;
}
