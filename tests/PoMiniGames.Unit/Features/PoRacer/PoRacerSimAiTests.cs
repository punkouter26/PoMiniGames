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
    [InlineData("circuit", true)]
    public void RaceCompletion_FinishesBotsOrSerializesDnf(string trackId, bool expireRace = false)
    {
        var sim = new PoRacerSim(Array.Empty<PoRacerLobbyPlayer>(), trackId);
        var noInput = new Dictionary<string, PoRacerInput>();
        if (expireRace)
        {
            VerifyCountdownAndRankings();
            // Advance the race clock past its safety cap without a real-time delay.
            typeof(PoRacerSim).GetField("_startElapsedMs", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
                .SetValue(sim, -181_000L);
            sim.Tick(0.02, noInput);
            var snapshot = sim.Snapshot("dnf");
            snapshot.Finished.Should().BeTrue();
            snapshot.Cars.Should().OnlyContain(c => !c.Finished && c.FinishTime == -1);
            var result = sim.BuildFinalResult("dnf");
            result.Standings.Should().OnlyContain(c => !c.Finished && c.TotalTimeSeconds == -1);
            // Both messages travel over SignalR when a race ends with unfinished cars.
            var snapshotJson = System.Text.Json.JsonSerializer.Serialize(snapshot);
            var resultJson = System.Text.Json.JsonSerializer.Serialize(result);
            System.Text.Json.JsonSerializer.Deserialize<PoRacerRaceSnapshot>(snapshotJson)!.Finished.Should().BeTrue();
            System.Text.Json.JsonSerializer.Deserialize<PoRacerFinalResult>(resultJson)!.Standings.Should().HaveCount(PoRacerCatalog.CarCount);
            return;
        }
        const double dt = 0.02;              // 50 Hz, matches the server tick rate
        const int maxTicks = 12_000;         // 240 sim-seconds hard budget

        var finishSec = new Dictionary<int, double>();
        int carCount = sim.Snapshot("t").Cars.Count;

        bool anyCarBoosted = false;
        bool anyCarHitSand = false;

        int tick = 0;
        for (; tick < maxTicks; tick++)
        {
            sim.Tick(dt, noInput);
            var snap = sim.Snapshot("t");
            foreach (var car in snap.Cars)
            {
                if (car.BoostTimer > 0) anyCarBoosted = true;
                if (car.Surface == "sand") anyCarHitSand = true;
                if (car.Finished && !finishSec.ContainsKey(car.Id))
                    finishSec[car.Id] = (tick + 1) * dt;
            }
            if (finishSec.Count == carCount) break;
        }

        var final = sim.Snapshot("t");
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
        if (PoRacerTrackRegistry.GetTrack(trackId).BoostPads.Count > 0)
            anyCarBoosted.Should().BeTrue("at least one car should drive over the track's boost pads");

        // Verify desert sand surface interaction
        if (trackId == "desertdustway")
        {
            anyCarHitSand.Should().BeTrue("desert dustway must trigger sand surface physics during cornering");
        }
    }

    private static void VerifyCountdownAndRankings()
    {
        const System.Reflection.BindingFlags flags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic;
        var sim = new PoRacerSim([new("connection", "Player", true, true, "owner")], countdownSeconds: 3);
        var input = new Dictionary<string, PoRacerInput> { ["owner"] = new() { Up = true } };
        var grid = sim.Snapshot("rules");
        sim.Tick(0.02, input);
        var waiting = sim.Snapshot("rules");
        waiting.Started.Should().BeFalse();
        waiting.CountdownSeconds.Should().BeInRange(1, 3);
        waiting.ElapsedRaceTime.Should().Be(0);
        waiting.Cars.Select(c => (c.X, c.Y, c.Speed)).Should().Equal(grid.Cars.Select(c => (c.X, c.Y, c.Speed)));
        typeof(PoRacerSim).GetField("_startElapsedMs", flags)!.SetValue(sim, -1L);
        sim.Tick(0.02, input);
        sim.Snapshot("rules").Cars[0].Speed.Should().BeGreaterThan(0);

        var cars = ((System.Collections.IEnumerable)typeof(PoRacerSim).GetField("_cars", flags)!.GetValue(sim)!).Cast<object>().ToArray();
        static void Set(object car, string name, object value) => car.GetType().GetField(name)!.SetValue(car, value);
        void Progress(object car, int lap, int node)
        {
            Set(car, "Lap", lap); Set(car, "LastCheckpoint", node); Set(car, "ProjIdx", node);
            Set(car, "CheckpointT", 0.0); Set(car, "ProjT", 0.0);
            typeof(PoRacerSim).GetMethod("UpdateRaceProgress", flags)!.Invoke(sim, [car]);
        }
        Progress(cars[0], 1, sim.Static.CenterXY.Count / 2 - 4);
        Progress(cars[1], 2, 1);
        typeof(PoRacerSim).GetMethod("Rank", flags)!.Invoke(sim, null);
        var ranked = sim.Snapshot("rules");
        ranked.Cars[1].Position.Should().BeLessThan(ranked.Cars[0].Position, "a whole lap must outweigh position within that lap");

        Set(cars[0], "Lap", 4); Set(cars[0], "FinishTime", 12.0); Set(cars[0], "DistanceAlongTrack", 999999.0);
        Set(cars[1], "Lap", 4); Set(cars[1], "FinishTime", 10.0);
        typeof(PoRacerSim).GetMethod("Rank", flags)!.Invoke(sim, null);
        var finish = sim.BuildFinalResult("rules");
        finish.Standings[0].CarId.Should().Be(1);
        finish.Standings[1].CarId.Should().Be(0);
        finish.Standings.Where(c => c.Finished).Select(c => c.TotalTimeSeconds).Should().BeInAscendingOrder();
        // Finished cars cannot gain another lap or move their crossing timestamp.
        var before = sim.Snapshot("rules").Cars[0];
        sim.Tick(0.02, input);
        var after = sim.Snapshot("rules").Cars[0];
        after.Lap.Should().Be(before.Lap);
        after.FinishTime.Should().Be(before.FinishTime);
    }
}
