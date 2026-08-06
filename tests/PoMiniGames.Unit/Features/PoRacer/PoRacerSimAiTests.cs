using FluentAssertions;
using PoMiniGames.Features.PoRacer;
using PoMiniGames.Shared.Games;
using Xunit.Abstractions;

namespace PoMiniGames.Unit.Features.PoRacer;

/// <summary>
/// Drives a bot-only PoRacer race (zero human players → the sim pads all 8 slots
/// with AI). Exercises <see cref="PoRacerSim.UpdateAi"/> headlessly so AI-driving
/// quality is measurable: every bot must actually complete the 3-lap race, in a
/// reasonable sim-time budget, as a spread-out field rather than a stuck pile-up.
/// </summary>
public class PoRacerSimAiTests
{
    private readonly ITestOutputHelper _out;
    public PoRacerSimAiTests(ITestOutputHelper output) => _out = output;

    [Fact]
    public void BotOnlyRace_AllBotsFinishThreeLaps_AsASpreadField()
    {
        var sim = new PoRacerSim(Array.Empty<PoRacerLobbyPlayer>());
        var noInput = new Dictionary<string, PoRacerInput>();
        const double dt = 0.02;              // 50 Hz, matches the server tick rate
        const int maxTicks = 12_000;         // 240 sim-seconds hard budget

        var finishSec = new Dictionary<int, double>();
        int carCount = sim.Snapshot("t", 0).Cars.Count;

        int tick = 0;
        for (; tick < maxTicks; tick++)
        {
            sim.Tick(dt, noInput);
            var snap = sim.Snapshot("t", 0);
            foreach (var car in snap.Cars)
                if (car.Finished && !finishSec.ContainsKey(car.Id))
                    finishSec[car.Id] = (tick + 1) * dt;
            if (finishSec.Count == carCount) break;
        }

        var final = sim.Snapshot("t", 0);
        int finished = final.Cars.Count(c => c.Finished);
        double raceSeconds = (tick + 1) * dt;

        _out.WriteLine($"cars={carCount} finished={finished} raceSeconds={raceSeconds:0.0}");
        foreach (var kv in finishSec.OrderBy(k => k.Value))
            _out.WriteLine($"  car {kv.Key} finished at {kv.Value:0.0}s");
        _out.WriteLine("final laps: " + string.Join(" ",
            final.Cars.OrderByDescending(c => c.Lap).Select(c => $"car{c.Id}:L{Math.Min(c.Lap, 3)}{(c.Finished ? "*" : "")}")));

        var names = final.Cars.Select(c => c.Name).ToList();
        names.Distinct().Count().Should().Be(names.Count,
            "each car needs a unique name (regression: the bot-fill loop once labelled all 8 'Vega')");

        finished.Should().Be(carCount, "every AI bot should complete the 3-lap race without getting stuck");

        var times = finishSec.Values.OrderBy(x => x).ToList();
        double winner = times.First();
        double last = times.Last();
        _out.WriteLine($"winner={winner:0.0}s last={last:0.0}s spread={last - winner:0.0}s");

        // A competent field completes 3 laps of this ~6-7k-unit track well inside the budget.
        winner.Should().BeLessThan(120, "the leading bot should not crawl");
        // Real racing produces a spread, not a synchronized train.
        (last - winner).Should().BeGreaterThan(0.5);
    }
}
