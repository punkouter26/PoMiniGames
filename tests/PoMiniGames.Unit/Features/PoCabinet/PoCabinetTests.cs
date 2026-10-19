using FluentAssertions;
using PoMiniGames.Features.PoCabinet;
using PoMiniGames.Shared.Games;
using Xunit;

namespace PoMiniGames.Unit.Features.PoCabinet;

/// <summary>PoCabinet's scripted talk, its track features and the daily circuit.</summary>
public class PoCabinetTests
{
    /// <summary>
    /// Each row runs one scenario: a private method below, named after what it checks.
    /// </summary>
    [Theory]
    [InlineData(nameof(ScriptedBanterCoversEveryOfficial_AndTheDebriefFollowsTheNumbers))]
    [InlineData(nameof(EveryTrackShipsItsFeatures_AndTheServerReadsTheSameRoad))]
    [InlineData(nameof(DailyCircuit_IsTheSameTrackFromTheSameDate_RacesForThreeDays_AndChangesDaily))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    /// <summary>
    /// The scripted pool covers every official and every kind the client asks for, and the
    /// debrief turns the numbers into the tips they justify.
    /// </summary>
    private static void ScriptedBanterCoversEveryOfficial_AndTheDebriefFollowsTheNumbers()
    {
        var pool = PoCabinetTalkService.Banter();
        pool.Lines.Keys.Should().BeEquivalentTo(["sean-s", "steve-b", "bill-b", "mike-p"]);
        pool.Lines.Values.SelectMany(k => k.Keys).Distinct().Should().BeEquivalentTo(PoCabinetTalkService.Kinds);

        var slow = PoCabinetTalkService.Debrief(new PoCabinetDebriefRequest(
            "capitol", 4, 5, 26.1, 24.9, [0.1, 0.9, -0.2], FullThrottlePct: 40, BrakePct: 10, TopKmh: 270,
            SlowestKmh: 150, WorstPointPct: 45, WallHits: 2, Laps: 3));
        slow.Tips.Should().HaveCount(3);
        slow.Tips[0].Should().Contain("Sector 2").And.Contain("0.90");
        slow.Tips[1].Should().Contain("Sector 3").And.Contain("quicker");
        slow.Tips[2].Should().Contain("2 barrier hits");
        slow.Headline.Should().Contain("P4");

        // Out-of-range numbers are clamped before anything is written from them.
        var wild = PoCabinetTalkService.Clamp(new PoCabinetDebriefRequest(
            "nowhere", 99, 99, double.NaN, -5, [1, 2], 400, -3, 9999, -1, 500, -2, 50));
        wild.TrackName.Should().Be(PoCabinetCatalog.GetTrack(PoCabinetCatalog.DefaultTrackId).Name);
        wild.Sectors.Should().BeEmpty();
        (wild.Position, wild.FullThrottle, wild.Brake, wild.WorstPoint, wild.WallHits).Should().Be((wild.TotalCars, 100, 0, 100, 0));
    }

    /// <summary>
    /// Every track's world carries a value per centerline sample for each feature (width,
    /// run-off, kerbs, racing line, heights), the hand-built tracks have the features they were
    /// built around (raised kerbs, gravel, tarmac run-off, a divider with a tapered nose), and
    /// the server's runtime track reads the very same values the browser is handed.
    /// </summary>
    private static void EveryTrackShipsItsFeatures_AndTheServerReadsTheSameRoad()
    {
        foreach (var info in PoCabinetCatalog.Tracks)
        {
            var world = PoCabinetTrackGeometry.BuildStaticWorld(info.Id);
            int n = world.CenterXY.Count / 2;
            new[] { world.HalfWidths.Count, world.RunoffLeft.Count, world.RunoffRight.Count, world.Kerbs.Count, world.RacingLine.Count, world.CenterZ.Count }
                .Should().AllBeEquivalentTo(n, $"{info.Id} ships every feature per sample");
            world.HalfWidths.Should().OnlyContain(hw => hw > 25, info.Id);
            if (info.Id != "playground") world.Kerbs.Should().Contain(k => k != 0, $"{info.Id} has apex kerbs (the marble run's chute bends are too gentle for any)");

            var track = PoCabinetTrack.Get(info.Id);
            Enumerable.Range(0, n).Should().OnlyContain(i =>
                track.HalfWidthAt(i) == world.HalfWidths[i] && track.KerbAt(i) == world.Kerbs[i]
                && track.RunoffAt(i, -1) == world.RunoffLeft[i] && track.RunoffAt(i, 1) == world.RunoffRight[i],
                $"{info.Id}: the server races the road the browser draws");
        }

        PoCabinetTrackGeometry.BuildStaticWorld("capitol").Kerbs.Should().Contain(k => Math.Abs(k) == 2, "the bus stop has raised kerbs");
        PoCabinetTrackGeometry.BuildStaticWorld("maralago").RunoffRight.Should().Contain((int)PoCabinetRunoff.Gravel, "sand traps");
        PoCabinetTrackGeometry.BuildStaticWorld("pressbriefing").RunoffLeft.Should().OnlyContain(k => k == (int)PoCabinetRunoff.Tarmac, "a plaza");

        // Senate Hill's divider: its own lane either side, a point at each end, and the AI and the
        // physics both know where it stands.
        var senate = PoCabinetTrack.Get("senate");
        senate.Islands.Should().ContainSingle();
        var isl = senate.Islands[0];
        senate.IslandIndexAt(isl.From).Should().Be(0);
        (senate.IslandHi(isl.From) - senate.IslandLo(isl.From)).Should().BeLessThan(isl.LatTo - isl.LatFrom, "the nose tapers");
        int mid = (isl.From + isl.To) / 2;
        (senate.IslandHi(mid) - senate.IslandLo(mid)).Should().Be(isl.LatTo - isl.LatFrom);
        senate.IslandIndexAt((isl.To + 1) % senate.Count).Should().Be(-1);
    }

    /// <summary>
    /// The daily circuit is built from the date alone, so the browser and the server (and two
    /// builds) agree on every value; laps post for yesterday's, today's and tomorrow's, not a
    /// stale one; and tomorrow is a different track.
    /// </summary>
    private static void DailyCircuit_IsTheSameTrackFromTheSameDate_RacesForThreeDays_AndChangesDaily()
    {
        var day = new DateOnly(2026, 10, 19);
        var id = PoCabinetDailyTrack.IdFor(day);
        id.Should().Be("daily-20261019");
        var a = PoCabinetTrackGeometry.BuildStaticWorld(id);
        var b = PoCabinetTrackGeometry.BuildStaticWorld("DAILY-20261019");
        a.CenterXY.Should().Equal(b.CenterXY);
        a.HalfWidths.Should().Equal(b.HalfWidths);
        a.Kerbs.Should().Equal(b.Kerbs);
        a.TrackName.Should().Be("Daily Circuit · Oct 19");
        a.TotalLaps.Should().Be(3);
        a.CenterZ.Should().HaveCount(a.CenterXY.Count / 2).And.Contain(z => z != 0, "the daily circuit has hills");
        PoCabinetTrack.Get(id).Length.Should().BeApproximately(3200, 5);

        var tomorrow = PoCabinetTrackGeometry.BuildStaticWorld(PoCabinetDailyTrack.IdFor(day.AddDays(1)));
        tomorrow.CenterXY.Should().NotEqual(a.CenterXY);

        var noon = new DateTime(2026, 10, 19, 12, 0, 0, DateTimeKind.Utc);
        PoCabinetDailyTrack.IsCurrent("daily-20261018", noon).Should().BeTrue("a race that ran over midnight still posts");
        PoCabinetDailyTrack.IsCurrent("daily-20261020", noon).Should().BeTrue();
        PoCabinetDailyTrack.IsCurrent("daily-20261010", noon).Should().BeFalse("a stale daily board is closed");
        PoCabinetDailyTrack.IsCurrent("daily-2026101", noon).Should().BeFalse();
        PoCabinetCatalog.IsKnownTrack(PoCabinetDailyTrack.TodayId(DateTime.UtcNow)).Should().BeTrue();
    }
}
