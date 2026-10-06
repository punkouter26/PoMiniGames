using FluentAssertions;
using PoMiniGames.Shared.Games.PoMule;

namespace PoMiniGames.Unit;

/// <summary>Who starts with what, and how a PoMule match is scored at the end.</summary>
public sealed class PoMuleScoringTests
{
    [Theory]
    [InlineData(Species.Gollumoid, 1000)]
    [InlineData(Species.Voltronix, 1000)]
    [InlineData(Species.OreGorger, 1000)]
    [InlineData(Species.CrystiteWeaver, 800)]
    [InlineData(Species.ZephyrFlapper, 1600)]
    [InlineData(Species.BonzCrusher, 1000)]
    [InlineData(Species.SpheroidDrifter, 1000)]
    [InlineData(Species.Humanoid, 1200)]
    public void NewMatch_SeatsTheHumanOnTheirSpecies_WithThePrdFunds(Species species, int cash)
    {
        var match = MatchState.New(seed: 5, humanSpecies: species);

        match.Players.Should().HaveCount(8);
        match.Players[0].Should().Match<PlayerState>(p =>
            p.Archetype == Archetype.Human && p.Species == species && p.Cash == cash);
        match.Players.Select(p => p.Species).Should().OnlyHaveUniqueItems();
        // Seats 1–7 hold each AI personality exactly once; the seed decides who sits where.
        match.Players.Skip(1).Select(p => p.Archetype).Order().Should().Equal(
            Archetype.Hoarder, Archetype.Industrialist, Archetype.Prospector, Archetype.Agitator,
            Archetype.Farmer, Archetype.Speculator, Archetype.Gambler);
        match.Players.Should().OnlyContain(p =>
            p.Goods[(int)Good.Food] == 4 && p.Goods[(int)Good.Energy] == 2 && p.Cash == PoMuleSpecies.Get(p.Species).StartingCash);
        (match.Month, match.Phase).Should().Be((1, Phase.Land));
        match.Store.Mules.Should().Be(28);

        var demo = MatchState.New(seed: 5, humanSpecies: null);
        demo.Players.Should().NotContain(p => p.Archetype == Archetype.Human);
    }

    [Fact]
    public void NetWorth_IsCashPlusLandPlusMulesPlusGoodsAtStorePrices_AndStandingsRankByIt()
    {
        var match = MatchState.New(seed: 9, humanSpecies: Species.Humanoid);
        var you = match.Players[0];
        you.Cash = 300;
        you.Goods[(int)Good.Food] = 10;      // 10 × 30
        you.Goods[(int)Good.Energy] = 0;
        you.Goods[(int)Good.Smithore] = 2;   //  2 × 50
        match.Owner[0] = 0;                  // 2 plots × 500
        match.Owner[1] = 0;
        match.Installed[1] = (sbyte)Good.Food; // 1 M.U.L.E. × 350

        PoMuleScoring.NetWorth(match, seat: 0).Should().Be(300 + 300 + 100 + 1000 + 350);

        var standings = PoMuleScoring.Standings(match);
        standings.Select(s => s.Rank).Should().Equal(1, 2, 3, 4, 5, 6, 7, 8);
        standings.Select(s => s.NetWorth).Should().BeInDescendingOrder();
        standings[0].Seat.Should().Be(0);
    }

    [Theory]
    [InlineData(60_000, 0, true)]
    [InlineData(60_000, 1, true)]
    [InlineData(59_999, 0, false)]
    [InlineData(90_000, 2, false)]
    public void Colony_SurvivesOnlyWithEnoughCombinedWealth_AndFewCrisisMonths(int combined, int crisisMonths, bool survives) =>
        PoMuleScoring.ColonySurvives(combined, crisisMonths).Should().Be(survives);
}
