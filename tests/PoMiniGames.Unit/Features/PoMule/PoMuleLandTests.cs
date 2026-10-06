using FluentAssertions;
using PoMiniGames.Shared.Games.PoMule;

namespace PoMiniGames.Unit;

/// <summary>The monthly land grant (eight cursors at once) and the even-month land auction.</summary>
public sealed class PoMuleLandTests
{
    private static MatchState Match(ulong seed = 3) => MatchState.New(seed, Species.Humanoid);

    private static int[] NoPicks() => Enumerable.Repeat(-1, PoMuleTuning.Seats).ToArray();

    [Fact]
    public void Grant_GivesAContestedPlotToOneClaimant_AndTheLosersTheNearestFreePlots()
    {
        var match = Match();
        var contested = PoMuleMap.Index(11, 6);
        var alone = PoMuleMap.Index(5, 1);
        var picks = NoPicks();
        picks[0] = picks[1] = picks[2] = contested;
        picks[3] = alone;
        picks[4] = PoMuleMap.Index(PoMuleMap.TownColumns[0], PoMuleMap.TownRow); // a town cannot be claimed

        var awarded = PoMuleLand.Grant(match, picks);

        awarded[3].Should().Be(alone);
        awarded.Take(3).Count(a => a == contested).Should().Be(1, "exactly one claimant wins the tile");
        foreach (var loser in awarded.Take(3).Where(a => a != contested))
            Ring(loser, contested).Should().Be(1, "a displaced claimant lands next door");
        Ring(awarded[4], picks[4]).Should().Be(1);
        awarded.Skip(5).Should().OnlyContain(a => a == -1, "no pick, no plot");

        var granted = awarded.Where(a => a >= 0).ToArray();
        granted.Should().OnlyHaveUniqueItems();
        foreach (var seat in Enumerable.Range(0, 5))
            match.Owner[awarded[seat]].Should().Be((sbyte)seat);
    }

    [Fact]
    public void Grant_NeverGivesOnePlotToTwoColonists_OverAThousandSeededMatches()
    {
        for (ulong seed = 1; seed <= 1000; seed++)
        {
            var match = Match(seed);
            var picker = new PoMuleRng(seed * 31);
            for (var month = 1; month <= PoMuleTuning.Months; month++)
            {
                // Everyone crowds the same few tiles to force conflicts.
                var picks = Enumerable.Range(0, PoMuleTuning.Seats).Select(_ => picker.Next(12)).ToArray();
                var before = (sbyte[])match.Owner.Clone();

                var awarded = PoMuleLand.Grant(match, picks);

                awarded.Should().OnlyHaveUniqueItems($"seed {seed} month {month}");
                awarded.Should().OnlyContain(a => before[a] == MatchState.Nobody && match.Map.Plots[a].Terrain != Terrain.Town);
            }
            match.Owner.Count(o => o != MatchState.Nobody).Should().Be(PoMuleTuning.Seats * PoMuleTuning.Months);
        }
    }

    [Fact]
    public void NearestFree_SearchesAcrossTheSeam_AndGivesUpWhenThePlanetIsFull()
    {
        var match = Match();
        var corner = PoMuleMap.Index(23, 0);
        // Own everything in columns 21–23 so the only way out is east, around the seam.
        foreach (var column in new[] { 21, 22, 23 })
            for (var row = 0; row < PoMuleMap.Rows; row++)
                match.Owner[PoMuleMap.Index(column, row)] = 7;

        var found = PoMuleLand.NearestFree(match, corner);

        (found % PoMuleMap.Columns).Should().Be(0, "column 24 wraps to column 1");
        (found / PoMuleMap.Columns).Should().BeLessThanOrEqualTo(1);

        Array.Fill(match.Owner, (sbyte)7);
        PoMuleLand.NearestFree(match, corner).Should().Be(-1);
        PoMuleLand.Grant(match, [corner, -1, -1, -1, -1, -1, -1, -1]).Should().OnlyContain(a => a == -1);
    }

    [Fact]
    public void Auction_RunsOnEvenMonths_TakesOnlyAffordableRaises_AndChargesTheWinner()
    {
        Enumerable.Range(1, 12).Where(PoMuleLand.IsAuctionMonth).Should().Equal(2, 4, 6, 8, 10, 12);

        var match = Match();
        var plots = PoMuleLand.PickAuctionPlots(match);
        plots.Should().HaveCount(PoMuleTuning.AuctionPlotsPerEvenMonth).And.OnlyHaveUniqueItems();
        plots.Should().OnlyContain(p => match.Owner[p] == MatchState.Nobody && match.Map.Plots[p].Terrain != Terrain.Town);

        PoMuleLand.OpenAuction(match, plots[0]);
        PoMuleLand.NextBid(match).Should().Be(PoMuleTuning.AuctionOpeningBid);
        match.Players[1].Cash = 500;
        match.Players[2].Cash = 200;

        PoMuleLand.Bid(match, seat: 1, PoMuleTuning.AuctionOpeningBid - 1).Should().BeFalse("below the opening bid");
        PoMuleLand.Bid(match, seat: 1, 180).Should().BeTrue();
        PoMuleLand.Bid(match, seat: 2, 180).Should().BeFalse("a bid must beat the standing one");
        PoMuleLand.Bid(match, seat: 2, 201).Should().BeFalse("more than seat 2 owns");
        PoMuleLand.Bid(match, seat: 2, 190).Should().BeTrue();
        PoMuleLand.Bid(match, seat: 1, 240).Should().BeTrue();
        PoMuleLand.Bid(match, seat: 1, 250).Should().BeFalse("nobody raises their own standing bid");
        PoMuleLand.NextBid(match).Should().Be(250);

        PoMuleLand.CloseAuction(match).Should().Be(1);
        match.Owner[plots[0]].Should().Be((sbyte)1);
        match.Players[1].Cash.Should().Be(260);
        match.Players[2].Cash.Should().Be(200, "losing bidders pay nothing");

        PoMuleLand.OpenAuction(match, plots[1]);
        PoMuleLand.CloseAuction(match).Should().Be(-1, "no bids, no sale");
        match.Owner[plots[1]].Should().Be(MatchState.Nobody);
    }

    /// <summary>Tiles apart, counting diagonals as one and going the short way round the globe.</summary>
    private static int Ring(int a, int b) => Math.Max(
        PoMuleMap.ColumnDistance(a % PoMuleMap.Columns, b % PoMuleMap.Columns),
        Math.Abs(a / PoMuleMap.Columns - b / PoMuleMap.Columns));
}
