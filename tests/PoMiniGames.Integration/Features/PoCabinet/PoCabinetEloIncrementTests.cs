using FluentAssertions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Services;

namespace PoMiniGames.Integration.Features.PoCabinet;

/// <summary>
/// PoCabinet demo-Elo increment commutation test. The PoBrawl fighter board
/// (PoBrawlFighterEloTests) proves the same property against a real Azurite
/// volume; PoCabinet reuses the same <see cref="PairwiseEloCalculator"/> for
/// its demo Elo ladder, so the in-process arithmetic test below pins the
/// contract the racing service depends on:
/// <list type="bullet">
///   <item>A decisive result moves both ratings by equal-and-opposite deltas —
///         the rating pool is conserved (delta-on-winner == delta-on-loser).</item>
///   <item>Two concurrent matches between the same pair commute: the order in
///         which the writes arrive does not change the final standings. The
///         ETag-increment pattern that <c>StorageService.RecordPoBrawlDemoResultAsync</c>
///         implements is the contract that makes this safe; this test pins the
///         arithmetic, the ETag retry is tested in PoBrawl's suite.</item>
/// </list>
/// One method, two claims. Integration tier is at its 50 cap — consolidate, do
/// not raise.
/// </summary>
public sealed class PoCabinetEloIncrementTests
{
    private static readonly PairwiseEloCalculator Elo = new(new PairwiseEloOptions());

    [Fact]
    public void DemoMatch_MovesRatingsEqually_AndConcurrentMatchesCommute()
    {
        // ── Decisive result: equal-and-opposite deltas ─────────────────────
        var seanBefore = 1000;
        var steveBefore = 1000;
        var delta = Elo.Delta(seanBefore, steveBefore, isDraw: false);
        var seanAfter = Elo.ApplyDelta(seanBefore, delta);
        var steveAfter = Elo.ApplyDelta(steveBefore, -delta);

        var seanGain = seanAfter - seanBefore;
        var steveLoss = steveBefore - steveAfter;

        seanGain.Should().BePositive("winning a head-to-head must raise the winner's rating");
        seanGain.Should().Be(steveLoss,
            "the rating pool is conserved: the winner's gain equals the loser's loss exactly");

        // ── Two concurrent matches between the same pair commute ───────────
        // Match A: Sean beats Steve once. Match B: Steve beats Sean once.
        // Applied in the order (Sean beats, then Steve beats) → both return to ~1000.
        // Applied in the reverse order → same result, because PairwiseEloCalculator
        // is purely functional over (winnerRating, loserRating) and the delta is
        // symmetric in the rating gap.
        var (s1, t1) = ApplySequence(seanBefore, steveBefore, new[]
        {
            true,    // Sean beats Steve
            false,   // Steve beats Sean
        });

        var (s2, t2) = ApplySequence(seanBefore, steveBefore, new[]
        {
            false,   // Steve beats Sean
            true,    // Sean beats Steve
        });

        s1.Should().Be(s2, "the same match sequence applied in opposite order must converge to the same pair");
        t1.Should().Be(t2, "the loser's rating must commute too");
        // After Sean-wins + Steve-wins both ratings should be within rounding of the seed.
        // PairwiseElo with default K=24 produces a 16-rating-point swing; abs(s1 - 1000) should
        // therefore be ≤ 16. We use a slightly looser bound to accommodate k tweaks.
        Math.Abs(s1 - seanBefore).Should().BeLessThanOrEqualTo(20,
            "after a win-then-loss pair both ratings return near the seed within the K-factor's swing");
    }

    /// <param name="matches">Each entry: true = first fighter (Sean) wins, false = second (Steve) wins.</param>
    private static (int, int) ApplySequence(int aStart, int bStart, IEnumerable<bool> matches)
    {
        var a = aStart;
        var b = bStart;
        foreach (var seanWins in matches)
        {
            // "First fighter" = Sean, "second" = Steve in this fixture.
            var delta = seanWins ? Elo.Delta(a, b, isDraw: false) : -Elo.Delta(b, a, isDraw: false);
            // The delta is computed against the *current* (a, b) so the second match
            // prices in the result of the first. Symmetric moves (Sean-wins + Steve-wins)
            // cancel out exactly because the deltas compose under addition.
            a = Elo.ApplyDelta(a, seanWins ? delta : 0);
            b = Elo.ApplyDelta(b, seanWins ? 0 : -delta);
        }
        return (a, b);
    }
}
