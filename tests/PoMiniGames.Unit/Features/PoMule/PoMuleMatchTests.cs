using FluentAssertions;
using PoMiniGames.Shared.Games.PoMule;

namespace PoMiniGames.Unit;

/// <summary>
/// Whole matches: the month cycle, determinism, saving between months, the renderer feed, and
/// the balance targets from SPEC.md §13.
/// </summary>
public sealed class PoMuleMatchTests
{
    [Fact]
    public void AMonth_RunsItsPhasesInOrder_WithAnAuctionOnlyOnEvenMonths_ForTwelveMonths()
    {
        var match = PoMuleMatch.New(seed: 42, humanSpecies: null, headless: true, fast: true);
        var phases = new Dictionary<int, List<Phase>>();
        var ticks = 0;
        while (match.State.Phase != Phase.Finished && ticks < 100_000)
        {
            var month = match.State.Month;
            if (!phases.TryGetValue(month, out var seen)) phases[month] = seen = [];
            if (seen.Count == 0 || seen[^1] != match.State.Phase) seen.Add(match.State.Phase);
            match.Advance(1);
            ticks++;
        }

        match.State.Phase.Should().Be(Phase.Finished);
        phases.Keys.Should().Equal(Enumerable.Range(1, 12));
        phases[1].Should().Equal(Phase.Land, Phase.Development, Phase.Production, Phase.Event, Phase.Market, Phase.Standings);
        phases[2].Should().Equal(Phase.Land, Phase.Auction, Phase.Development, Phase.Production, Phase.Event, Phase.Market, Phase.Standings);
        match.State.History.Should().HaveCount(12);

        // A demo runs at four times speed: 5 to 8 minutes on the wall clock.
        var demoMinutes = ticks / (double)PoMuleTuning.TicksPerSecond / 4 / 60;
        demoMinutes.Should().BeInRange(5, 8);
    }

    [Fact]
    public void TheSameSeed_PlaysTheSameMatch_AndADifferentSeedDoesNot()
    {
        var first = PoMuleSave.ToJson(PoMuleMatch.RunToEnd(1234).State);

        PoMuleSave.ToJson(PoMuleMatch.RunToEnd(1234).State).Should().Be(first);
        PoMuleSave.ToJson(PoMuleMatch.RunToEnd(1235).State).Should().NotBe(first);
    }

    /// <summary>Pins one whole match, so an accidental rules change shows up as a diff.</summary>
    [Fact]
    public Task Seed42_DemoMatch_FinalStandings()
    {
        var match = PoMuleMatch.RunToEnd(42);
        return Verifier.Verify(new
        {
            Standings = PoMuleScoring.Standings(match.State).Select(s => $"{s.Rank}. {s.Name} {s.NetWorth}"),
            match.State.CrisisMonths,
            StoreMules = match.State.Store.Mules,
            StorePrices = match.State.Store.Price,
        });
    }

    [Fact]
    public void ASaveTakenAtTheStartOfAMonth_RestoresItExactly_AndPlaysOnIdentically()
    {
        var original = PoMuleMatch.New(seed: 77, humanSpecies: Species.Humanoid, headless: true, fast: true);
        var stops = 0;
        while (original.State.Month < 3)
            if (original.Advance(500)) stops++;
        stops.Should().Be(2, "Advance stops at the start of each new month so it can be saved there");
        var json = PoMuleSave.ToJson(original.State);

        var restored = PoMuleSave.FromJson(json)!;
        restored.Month.Should().Be(3);
        restored.Phase.Should().Be(Phase.Land);
        restored.Players.Select(p => p.Cash).Should().Equal(original.State.Players.Select(p => p.Cash));
        restored.Players.SelectMany(p => p.Goods).Should().Equal(original.State.Players.SelectMany(p => p.Goods));
        restored.Owner.Should().Equal(original.State.Owner);
        restored.Installed.Should().Equal(original.State.Installed);
        restored.Store.Stock.Should().Equal(original.State.Store.Stock);
        restored.Map.Plots.Should().Equal(original.State.Map.Plots);

        var resumed = new PoMuleMatch(restored) { Headless = true, Fast = true };
        original.Advance(3000);
        resumed.Advance(3000);
        PoMuleSave.ToJson(resumed.State).Should().Be(PoMuleSave.ToJson(original.State));

        PoMuleSave.FromJson(null).Should().BeNull();
        PoMuleSave.FromJson("{ not json").Should().BeNull();
        PoMuleSave.FromJson(json.Replace("\"Version\":1", "\"Version\":0")).Should().BeNull("an older rules version is discarded");
    }

    [Fact]
    public void OverAHundredSeededMatches_NothingGoesNegative_TheStoreKeepsMules_AndNoPersonalityDominates()
    {
        var wins = new Dictionary<Archetype, int>();
        var survived = 0;
        for (ulong seed = 1; seed <= 100; seed++)
        {
            var match = PoMuleMatch.New(seed, humanSpecies: null, headless: true, fast: true);
            var mulesAfterMonthOne = -1;
            while (match.State.Phase != Phase.Finished)
            {
                match.Advance(50);
                var s = match.State;
                s.Players.Should().OnlyContain(p => p.Cash >= 0 && p.Goods.All(g => g >= 0), $"seed {seed} month {s.Month}");
                (s.Store.Mules >= 0 && s.Store.Stock.All(g => g >= 0)).Should().BeTrue($"seed {seed} month {s.Month}");
                if (mulesAfterMonthOne < 0 && s.Month == 2) mulesAfterMonthOne = s.Store.Mules;
            }

            mulesAfterMonthOne.Should().BeGreaterThanOrEqualTo(1, $"seed {seed}: the Store must not sell out in month 1");
            var standings = PoMuleScoring.Standings(match.State);
            var winner = match.State.Players[standings[0].Seat].Archetype;
            wins[winner] = wins.GetValueOrDefault(winner) + 1;
            if (PoMuleScoring.ColonySurvives(standings.Sum(x => x.NetWorth), match.State.CrisisMonths)) survived++;
        }

        survived.Should().BeInRange(40, 90, "the colony should usually, but not always, pull through");
        wins.Values.Max().Should().BeLessThanOrEqualTo(40, $"wins by personality: {string.Join(", ", wins.Select(w => $"{w.Key} {w.Value}"))}");
    }

    [Fact]
    public void WithARenderer_TheMatchWaitsForArrivals_AndFeedsOneFlatSnapshot()
    {
        var match = PoMuleMatch.New(seed: 8, humanSpecies: Species.Humanoid);
        var state = match.State;
        // The player can point at a plot before the land phase has ticked even once.
        state.LandPicks[0] = PoMuleMap.Index(5, 6);
        while (state.Phase != Phase.Development) match.Advance(1);
        state.Owner.Count(o => o == 0).Should().Be(1, "a pick made in the first instant still counts");
        state.LandPicks.Should().OnlyContain(p => p == -1, "picks do not carry into next month");
        match.Advance(1);
        var ai = state.Players.First(p => p.Archetype == Archetype.Farmer).Seat;
        var plot = Array.IndexOf(state.Owner, (sbyte)ai);
        plot.Should().BeGreaterThanOrEqualTo(0, "every AI claimed land in month 1");

        // Nothing happens to an AI until the renderer says it got there.
        match.Advance(100);
        state.Installed[plot].Should().Be(MatchState.Nobody);
        match.Goals[ai].Kind.Should().Be(GoalKind.Outfitter);
        match.Arrive(ai);
        match.Advance(1);
        match.Goals[ai].Should().Be(new Goal(GoalKind.Install, plot, (Good)state.Players[ai].Outfit));
        match.Arrive(ai);
        state.Installed[plot].Should().NotBe(MatchState.Nobody);

        var snap = match.Snapshot();
        snap.Should().HaveCount(PoMuleMatch.SnapshotHeader + PoMuleMatch.SnapshotPerSeat * PoMuleTuning.Seats);
        (snap[0], snap[1], snap[2]).Should().Be((1d, (double)(int)Phase.Development, (double)state.ClockTicks));
        var o = PoMuleMatch.SnapshotHeader + ai * PoMuleMatch.SnapshotPerSeat;
        snap[o].Should().Be(state.Players[ai].Cash);
        snap[o + 5].Should().Be(state.Players[ai].SpeedPercent);

        // A dash bump from the renderer costs the victim its M.U.L.E.; the human's pub visit ends the wait.
        PoMuleDevelopment.BuyMule(state, 0).Should().Be(Outcome.Ok);
        match.Bump(victim: 0, dashing: true).Should().BeTrue();
        match.Notices.Should().Contain(new Notice(NoticeKind.MuleRanAway, 0));
        match.HumanPub().Should().BeGreaterThan(0);
        state.Players[0].InPub.Should().BeTrue();
    }
}
