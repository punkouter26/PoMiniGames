using FluentAssertions;
using PoMiniGames.Features.PoCabinet;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.E2EAPI.Features.PoCabinet;

/// <summary>
/// E2E-API contract test for the PoCabinet AI roster, the sim and the dialogue pipeline.
/// One method by design (the E2E-API tier is capped at 25 and the hermetic tiers are full
/// per the 100/50/25/25 rule):
/// <list type="bullet">
///   <item>Each of the four named officials, alone on the track, completes a lap through the
///         real physics — the sim moved no car at all before 2026-09-23 — and holds its own
///         line: every pair's mean lateral offsets over the lap differ by ≥ 8 units.</item>
///   <item>A human car obeys its inputs and the barrier: full throttle with full right lock
///         ends up pinned at the wall, never through it, and every applied input's
///         sequence number is acknowledged.</item>
///   <item><see cref="PoCabinetDialogue.PickLine"/> is deterministic by
///         <c>(official, kind, raceTick)</c>, and the pool passes the banned-token scan.</item>
/// </list>
/// </summary>
public sealed class PoCabinetAiPersonalityTests
{
    private const double Dt = 1.0 / 30.0;
    private const int LapTicks = 30 * 60; // a minute of sim time; a lap takes well under half that

    [Fact]
    public void EachOfficial_LapsOnItsOwnLine_HumanCarObeysWalls_AndDialogueIsDeterministicAndClean()
    {
        // ── Part 1: every official laps, on a distinct line ──────────────
        var laterals = new Dictionary<string, List<double>>();
        foreach (var o in PoCabinetPersonality.Roster)
        {
            var sim = new PoCabinetSim("capitol", seed: 42,
            [
                new PoCabinetDriver("bot", o.Name, IsPlayer: false, o.Color, o.Personality, o.MaxSpeed, o.CorneringSkill, o.Id),
            ]);
            var car = sim.SnapshotCars()[0];
            var series = new List<double>();
            for (var i = 0; i < LapTicks && car.LapsDone < 1; i++)
            {
                sim.Tick(Dt, new Dictionary<string, PoCabinetInput>());
                // Sample the settled part of the lap, past the grid and the first turn-in.
                if (car.Distance > 150) series.Add(car.Lateral);
            }
            car.LapsDone.Should().BeGreaterThanOrEqualTo(1, $"{o.Id} must complete a lap under the real physics");
            car.BestLapSeconds.Should().BeInRange(12, 60, $"{o.Id}'s lap time must be a plausible arcade lap");
            laterals[o.Id] = series;
        }

        var ids = laterals.Keys.ToList();
        for (var i = 0; i < ids.Count; i++)
        {
            for (var j = i + 1; j < ids.Count; j++)
            {
                var gap = Math.Abs(laterals[ids[i]].Average() - laterals[ids[j]].Average());
                gap.Should().BeGreaterThanOrEqualTo(8,
                    $"{ids[i]} and {ids[j]} must hold visibly different lines (mean lateral gap {gap:F1})");
            }
        }

        // ── Part 1b: a human car obeys inputs and the barrier ───────────
        var human = new PoCabinetSim("capitol", seed: 1, [new PoCabinetDriver("me", "Me", IsPlayer: true, "#fff", null)]);
        var me = human.SnapshotCars()[0];
        var wall = PoCabinetPhysics.WallLateral(human.Track);
        for (var seq = 1; seq <= 150; seq++)
        {
            human.Tick(Dt, new Dictionary<string, PoCabinetInput>
            {
                ["me"] = new() { Throttle = 1, Steer = 1, Seq = seq },
            });
            Math.Abs(me.Lateral).Should().BeLessThanOrEqualTo(wall + 0.5, "no car may pass through the barrier");
        }
        me.AckSeq.Should().Be(150, "every applied input must be acknowledged");
        me.Speed.Should().BeGreaterThan(0, "throttle moves the car");

        // ── Part 2: dialogue determinism ─────────────────────────────────
        var firstCall = PoCabinetDialogue.PickLine("sean-s", DialogueKind.PreRace, 12);
        for (var n = 0; n < 50; n++)
        {
            PoCabinetDialogue.PickLine("sean-s", DialogueKind.PreRace, 12)
                .Should().Be(firstCall,
                    "the same (official, kind, raceTick) triple must always return the same line");
        }
        var tick0 = PoCabinetDialogue.PickLine("steve-b", DialogueKind.PreRace, 0);
        var tick999 = PoCabinetDialogue.PickLine("steve-b", DialogueKind.PreRace, 999);
        tick0.Should().NotBe(tick999, "different race ticks should land on different pool indices");

        // ── Part 3: banned-token scan ────────────────────────────────────
        PoCabinetDialogue.PoolContentIsClean()
            .Should().BeTrue("no pool line may contain a banned token");

        // Pool exhaustion fallback returns the generic dot, not an exception.
        PoCabinetDialogue.PickLine("unknown-official", DialogueKind.PreRace, 0)
            .Should().Be(PoCabinetDialogue.Fallbacks[DialogueKind.PreRace]);
    }
}
