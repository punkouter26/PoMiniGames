using FluentAssertions;
using PoMiniGames.Features.PoCabinet;
using PoMiniGames.Shared.Games;
using Xunit;

namespace PoMiniGames.Unit.Features.PoCabinet;

public class PoCabinetTalkServiceTests
{
    /// <summary>
    /// The scripted pool covers every official and every kind the client asks for, and the
    /// debrief turns the numbers into the tips they justify.
    /// </summary>
    [Fact]
    public void ScriptedBanterCoversEveryOfficial_AndTheDebriefFollowsTheNumbers()
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
}
