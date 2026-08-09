using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using PoMiniGames.Domain.Models;

namespace PoMiniGames.Integration;

/// <summary>
/// PoBrawl demo-mode fighter Elo round-trip against a real Azurite container: a recorded
/// CPU-vs-CPU result moves both fighters' ratings in opposite directions by the same amount,
/// a draw moves the draw counters, and the roster allowlist rejects unrateable submissions
/// at the HTTP boundary before they can mint a row.
/// </summary>
/// <remarks>
/// <para>
/// Every assertion here is <b>relative</b> — deltas between a before and after snapshot —
/// never an absolute rating. The roster is a fixed set of ids, so unlike the player boards
/// this test cannot isolate itself behind a unique row key: it shares the fifteen fighter
/// rows with every other run against the same Azurite volume. Asserting "FDR is 1012" would
/// pass exactly once and then fail forever.
/// </para>
/// <para>
/// This is one test method covering the whole contract on purpose. The Integration tier is
/// at its 50-method ceiling (see <see cref="IntegrationTestCountCeilingTests"/>), and the
/// rule is to consolidate rather than raise the cap.
/// </para>
/// </remarks>
public sealed class PoBrawlFighterEloTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly TestWebApplicationFactory _factory;

    public PoBrawlFighterEloTests(TestWebApplicationFactory factory) => _factory = factory;

    // Two fighters that no other test touches. count=50 because the roster is 15 and the
    // endpoint defaults to a top-10 board — the fighters under test need not be winning.
    private const string Winner = "fdr";
    private const string Loser = "truman";

    private static async Task<PoBrawlFighterRating> RatingOf(HttpClient client, string fighterId)
    {
        var board = await client.GetFromJsonAsync<List<PoBrawlFighterRating>>("/api/pobrawl/elo?count=50");
        return board!.SingleOrDefault(r => r.FighterId == fighterId)
            // A fighter with no recorded match has no row yet; the seed rating is what the
            // server would price its first match against.
            ?? new PoBrawlFighterRating { FighterId = fighterId, Elo = 1000 };
    }

    [Fact]
    public async Task RecordDemoResult_MovesBothRatings_AndRejectsUnrateableFighters()
    {
        if (!_factory.DockerAvailable) return;
        // §2 CSRF: the POSTs below are state-changing /api/* calls and are refused without
        // the synchroniser token. Armed up front so the validation assertions at the end
        // exercise a real 400 rather than collapsing into a blanket 403.
        var client = await _factory.CreateClient().ArmAntiforgeryAsync();

        // ── A decisive result moves both ratings, zero-sum ────────────────
        var winnerBefore = await RatingOf(client, Winner);
        var loserBefore = await RatingOf(client, Loser);

        var post = await client.PostAsJsonAsync(
            "/api/pobrawl/elo", new { winnerFighterId = Winner, loserFighterId = Loser, isDraw = false });
        post.StatusCode.Should().Be(HttpStatusCode.OK);

        var winnerAfter = await RatingOf(client, Winner);
        var loserAfter = await RatingOf(client, Loser);

        var gain = winnerAfter.Elo - winnerBefore.Elo;
        var drop = loserBefore.Elo - loserAfter.Elo;

        gain.Should().BePositive("beating a comparable opponent must raise the winner's rating");
        gain.Should().Be(drop,
            "the delta is rounded once and applied as +d/-d, so the rating pool is conserved exactly");

        winnerAfter.Wins.Should().Be(winnerBefore.Wins + 1);
        loserAfter.Losses.Should().Be(loserBefore.Losses + 1);
        winnerAfter.DisplayName.Should().Be("FDR", "the display name is resolved server-side from the roster");

        // ── A draw counts as a draw for both sides ────────────────────────
        (await client.PostAsJsonAsync(
            "/api/pobrawl/elo", new { winnerFighterId = Winner, loserFighterId = Loser, isDraw = true }))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        var winnerDrawn = await RatingOf(client, Winner);
        var loserDrawn = await RatingOf(client, Loser);

        winnerDrawn.Draws.Should().Be(winnerAfter.Draws + 1);
        loserDrawn.Draws.Should().Be(loserAfter.Draws + 1);
        winnerDrawn.Wins.Should().Be(winnerAfter.Wins, "a draw is not a win");
        (winnerDrawn.Elo - winnerAfter.Elo).Should().Be(-(loserDrawn.Elo - loserAfter.Elo),
            "a draw is zero-sum too — the now higher-rated fighter gives points back");

        // ── The roster allowlist is the row-creation gate ─────────────────
        // An unrateable id must never reach storage: the rating partition is bounded at the
        // roster size precisely because ids are validated here.
        (await client.PostAsJsonAsync(
            "/api/pobrawl/elo", new { winnerFighterId = "notapresident", loserFighterId = Loser, isDraw = false }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // BOB is a real fighter in 1P/2P but never a demo combatant, so he is off the board.
        (await client.PostAsJsonAsync(
            "/api/pobrawl/elo", new { winnerFighterId = "bob", loserFighterId = Loser, isDraw = false }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // A fighter cannot fight itself — one row, two conflicting increments.
        (await client.PostAsJsonAsync(
            "/api/pobrawl/elo", new { winnerFighterId = Winner, loserFighterId = Winner, isDraw = false }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        var board = await client.GetFromJsonAsync<List<PoBrawlFighterRating>>("/api/pobrawl/elo?count=50");
        board!.Should().NotContain(r => r.FighterId == "notapresident" || r.FighterId == "bob",
            "a rejected submission must not have created a row");
        board.Should().BeInDescendingOrder(r => r.Elo, "the board ranks by rating");
    }
}
