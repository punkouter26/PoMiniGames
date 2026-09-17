using FluentAssertions;
using PoMiniGames.Features.PoRacer;
using PoMiniGames.Shared.Games;
using Xunit;
using Xunit.Abstractions;

namespace PoMiniGames.Unit.Features.PoRacer;

/// <summary>
/// Headless multi-track simulation tests. Verifies all 3 tracks (circuit, neonskyline, desertdustway),
/// surface physics detection (sand grip reduction), boost pad triggering, and AI lap completion.
/// </summary>
public class PoRacerSimAiTests
{
    private readonly ITestOutputHelper _out;
    public PoRacerSimAiTests(ITestOutputHelper output) => _out = output;

    [Theory]
    [InlineData("circuit")]
    [InlineData("neonskyline")]
    [InlineData("desertdustway")]
    public void BotOnlyRace_AllBotsFinishThreeLaps_OnAllTracks(string trackId)
    {
        var sim = new PoRacerSim(Array.Empty<PoRacerLobbyPlayer>(), trackId);
        var noInput = new Dictionary<string, PoRacerInput>();
        const double dt = 0.02;              // 50 Hz, matches the server tick rate
        const int maxTicks = 12_000;         // 240 sim-seconds hard budget

        var finishSec = new Dictionary<int, double>();
        int carCount = sim.Snapshot("t", 0).Cars.Count;

        bool anyCarBoosted = false;
        bool anyCarHitSand = false;

        int tick = 0;
        for (; tick < maxTicks; tick++)
        {
            sim.Tick(dt, noInput);
            var snap = sim.Snapshot("t", 0);
            foreach (var car in snap.Cars)
            {
                if (car.BoostTimer > 0) anyCarBoosted = true;
                if (car.Surface == "sand") anyCarHitSand = true;
                if (car.Finished && !finishSec.ContainsKey(car.Id))
                    finishSec[car.Id] = (tick + 1) * dt;
            }
            if (finishSec.Count == carCount) break;
        }

        var final = sim.Snapshot("t", 0);
        int finished = final.Cars.Count(c => c.Finished);
        double raceSeconds = (tick + 1) * dt;

        _out.WriteLine($"track={trackId} cars={carCount} finished={finished} raceSeconds={raceSeconds:0.0}");
        foreach (var kv in finishSec.OrderBy(k => k.Value))
            _out.WriteLine($"  car {kv.Key} finished at {kv.Value:0.0}s");
        foreach (var c in final.Cars.Where(c => !c.Finished))
            _out.WriteLine($"  UNFINISHED car {c.Id} ({c.Name}): Lap={c.Lap}, Pos=({c.X:0.0},{c.Y:0.0}), Speed={c.Speed:0.0}");

        var names = final.Cars.Select(c => c.Name).ToList();
        names.Distinct().Count().Should().Be(names.Count,
            "each car needs a unique name");

        finished.Should().Be(carCount, $"every AI bot should complete the 3-lap race on {trackId} without getting stuck");

        var times = finishSec.Values.OrderBy(x => x).ToList();
        double winner = times.First();
        double last = times.Last();
        _out.WriteLine($"winner={winner:0.0}s last={last:0.0}s spread={last - winner:0.0}s");

        winner.Should().BeLessThan(140, "the leading bot should not crawl");
        (last - winner).Should().BeGreaterThan(0.2, "racing should produce a spread");

        // Verify boost pad triggering on all tracks
        anyCarBoosted.Should().BeTrue("at least one car should drive over boost pads during the race");

        // Verify desert sand surface interaction
        if (trackId == "desertdustway")
        {
            anyCarHitSand.Should().BeTrue("desert dustway must trigger sand surface physics during cornering");
        }
    }
}
