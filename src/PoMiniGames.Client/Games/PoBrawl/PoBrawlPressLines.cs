using PoMiniGames.Domain.Primitives;
using PoMiniGames.Shared.Games;

namespace PoMiniGamesClient.Games.PoBrawl;

/// <summary>A line someone says, and who said it.</summary>
public sealed record PoBrawlPressLine(string Speaker, string Text);

/// <summary>
/// The ring announcer's introduction and the post-fight press-conference line. Scripted and
/// picked in the browser — no server call — and stable for the same fight, so a replayed result
/// reads the same line.
/// </summary>
public static class PoBrawlPressLines
{
    /// <summary>Who reads the introduction.</summary>
    public const string Announcer = "Ring announcer";

    /// <summary>What the speaker did in the fight, from the speaker's own side.</summary>
    public sealed record Bout(
        string SpeakerId, string OpponentId, PoBrawlOutcome Outcome, bool Knockout,
        int Hits, int OpponentHits, int Blocks, int BestCombo, int BiggestHit, int Seconds);

    /// <summary>The PA introduction for a pairing, or null when either id is not a fighter.</summary>
    public static PoBrawlPressLine? Intro(string p1Id, string p2Id)
    {
        var left = NameFor(p1Id);
        var right = NameFor(p2Id);
        if (left is null || right is null) return null;
        string[] lines =
        [
            $"In the left corner, {left}! In the right corner, {right}! Sixty seconds, one round — let's get ready to brawl!",
            $"Ladies and gentlemen, from the left, {left}! And from the right, the one and only {right}! Touch gloves and come out swinging!",
            $"Tonight's main event: {left} versus {right}! One round, no recounts. Fighters, to your marks!",
        ];
        return new PoBrawlPressLine(Announcer, Pick(lines, $"{left}|{right}"));
    }

    /// <summary>The speaker's press-conference line, or null when either id is not a fighter.</summary>
    public static PoBrawlPressLine? Press(Bout b)
    {
        var speaker = NameFor(b.SpeakerId);
        var opp = NameFor(b.OpponentId);
        if (speaker is null || opp is null) return null;
        var knockout = b.Knockout && b.Outcome != PoBrawlOutcome.Draw;
        string[] lines = (b.Outcome, knockout) switch
        {
            (PoBrawlOutcome.Win, true) =>
            [
                $"{b.Hits} clean shots and {opp} is taking a nap. I'd call that a mandate.",
                $"I said it would end early. {opp} didn't get the memo.",
                $"A {b.BestCombo}-hit combo. Frankly, the canvas owes me a thank-you note.",
            ],
            (PoBrawlOutcome.Win, false) =>
            [
                $"The judges saw it, the crowd saw it. {b.Hits} hits don't lie.",
                $"{opp} is tough, I'll give them that. Just not sixty-seconds-of-me tough.",
            ],
            (PoBrawlOutcome.Loss, true) =>
            [
                "I'd like to see the replay. Then I'd like to never see it again.",
                $"{opp} got lucky. {b.OpponentHits} times, apparently.",
            ],
            (PoBrawlOutcome.Loss, false) =>
            [
                $"We lost the decision, not the argument. I want a recount of those {b.OpponentHits} hits.",
                "Sixty seconds wasn't enough. Give me sixty-one next time.",
            ],
            _ =>
            [
                $"A draw. {opp} and I finally agree on something: nobody won.",
                "Even on the cards. I'll take the rematch any day of the week.",
            ],
        };
        var fingerprint = $"{speaker}|{opp}|{b.Outcome}|{knockout}|{b.Hits}|{b.OpponentHits}|{b.Blocks}|{b.BestCombo}|{b.BiggestHit}|{b.Seconds}";
        return new PoBrawlPressLine(speaker, Pick(lines, fingerprint));
    }

    private static string? NameFor(string? id)
    {
        if (string.Equals(id, PoBrawlRoster.Bob.Id, StringComparison.OrdinalIgnoreCase)) return PoBrawlRoster.Bob.Name;
        var canonical = PoBrawlRoster.Canonicalize(id);
        return canonical is null ? null : PoBrawlRoster.DisplayName(canonical);
    }

    /// <summary>FNV-1a over the text: the same fight always picks the same line.</summary>
    private static string Pick(string[] lines, string key)
    {
        var hash = 2166136261u;
        foreach (var c in key)
        {
            hash ^= c;
            hash *= 16777619u;
        }
        return lines[hash % (uint)lines.Length];
    }
}
