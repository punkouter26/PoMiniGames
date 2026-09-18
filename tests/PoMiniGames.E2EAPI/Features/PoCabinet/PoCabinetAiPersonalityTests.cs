using FluentAssertions;
using PoMiniGames.Features.PoCabinet;

namespace PoMiniGames.E2EAPI.Features.PoCabinet;

/// <summary>
/// E2E-API contract test for the PoCabinet AI roster + dialogue pipeline. Three
/// claims, one method by design (the E2E-API tier is capped at 25 and the hermetic
/// tiers are full per the 100/50/25/25 rule):
/// <list type="bullet">
///   <item>Each of the four named officials produces a distinct driving line on the
///         same track over the same number of ticks — a ≥ 5° average heading delta
///         vs every other official, which is what gives the satirical roster its bite.</item>
///   <item><see cref="PoCabinetDialogue.PickLine"/> is deterministic by
///         <c>(official, kind, raceTick)</c> — same triple → same line, regardless of
///         how many times the picker is invoked.</item>
///   <item>The dialogue pool passes the banned-token scan; no slur placeholder or
///         targeted-harassment marker ever appears in any authored line.</item>
/// </list>
/// </summary>
public sealed class PoCabinetAiPersonalityTests
{
    private const int TickCount = 200; // ~6.6 s of sim time at 30 Hz

    [Fact]
    public void EachOfficial_ProducesDistinctLines_AndDialogueIsDeterministic_AndContentIsClean()
    {
        // ── Part 1: distinct driving lines ───────────────────────────────
        var headings = new Dictionary<string, List<double>>();
        var officials = new[]
        {
            ("sean-s", PoCabinetPersonality.Officials.SeanS),
            ("steve-b", PoCabinetPersonality.Officials.SteveB),
            ("bill-b", PoCabinetPersonality.Officials.BillB),
            ("mike-p", PoCabinetPersonality.Officials.MikeP),
        };

        foreach (var (id, personality) in officials)
        {
            var drivers = new List<PoCabinetDriver>
            {
                new("owner", id, IsPlayer: false, Color: "#000000", Personality: personality),
            };
            var sim = new PoCabinetSim("capitol", seed: 42, drivers);
            var inputs = new Dictionary<string, PoCabinetInput>();
            var series = new List<double>();
            for (var i = 0; i < TickCount; i++)
            {
                sim.Tick(1.0 / 30.0, inputs);
                series.Add(sim.SnapshotCars()[0].Heading);
            }
            headings[id] = series;
        }

        // Compare every pair — average heading delta must be ≥ 5°.
        var ids = headings.Keys.ToList();
        for (var i = 0; i < ids.Count; i++)
        {
            for (var j = i + 1; j < ids.Count; j++)
            {
                var a = headings[ids[i]];
                var b = headings[ids[j]];
                double totalDelta = 0;
                for (var k = 0; k < a.Count; k++)
                {
                    totalDelta += Math.Abs(PoCabinetAiDriver.ShortAngleDiff(a[k], b[k]));
                }
                var avgDeg = (totalDelta / a.Count) * (180.0 / Math.PI);
                avgDeg.Should().BeGreaterThanOrEqualTo(5.0,
                    $"{ids[i]} and {ids[j]} must drive visibly different lines (saw {avgDeg:F2}°)");
            }
        }

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
