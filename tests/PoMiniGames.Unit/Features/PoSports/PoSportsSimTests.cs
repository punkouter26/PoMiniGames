using FluentAssertions;
using PoMiniGames.Features.PoSports;

namespace PoMiniGames.Unit.Features.PoSports;

/// <summary>
/// Pins the server-authoritative stride model to the exact constants shared with
/// physics.js. These values ARE the contract — if a test here needs a new expected
/// number, the JS engine must change in the same commit (see PoSportsConstantsSyncTests).
/// Scenarios are grouped per mechanic to respect the Unit tier's 100-method ceiling.
/// </summary>
public sealed class PoSportsSimTests
{
    private const double Dt = 1.0 / 60.0;

    /// <summary>A 2-lane sim (1 human + 1 AI), gun already fired, sprint underway.</summary>
    private static PoSportsSim StartedSim()
    {
        var sim = new PoSportsSim(
        [
            new PoSportsSim.LaneSetup("Alice", "kim", IsAi: false),
            new PoSportsSim.LaneSetup("CPU", "matt", IsAi: true),
        ], seed: 42);
        sim.SkipCountdown();
        return sim;
    }

    private static void CompleteSequence(PoSportsSim sim, int lane)
    {
        for (var step = 0; step < 4; step++) sim.HandleSequenceKey(lane, step);
    }

    [Fact]
    public void StrideModel_ImpulseExact_DecayExact_SpeedCapped()
    {
        // One completed sequence from rest injects exactly one impulse.
        var sim = StartedSim();
        CompleteSequence(sim, 0);
        sim.Lane(0).Speed.Should().Be(PoSportsConstants.Impulse);

        // Two idle seconds decay it by Decay² (the per-tick powers compose exactly).
        for (var i = 0; i < 120; i++) sim.Tick(Dt);
        var expected = PoSportsConstants.Impulse * Math.Pow(PoSportsConstants.Decay, 2);
        sim.Lane(0).Speed.Should().BeApproximately(expected, 0.005);

        // Impulse spam saturates at MaxSpeed.
        for (var i = 0; i < 20; i++) CompleteSequence(sim, 0);
        sim.Lane(0).Speed.Should().Be(PoSportsConstants.MaxSpeed);
    }

    [Fact]
    public void SequenceRules_WrongKeyResets_FalseStartHolds()
    {
        // Wrong key mid-cycle: progress resets, banked speed untouched.
        var sim = StartedSim();
        CompleteSequence(sim, 0);
        sim.HandleSequenceKey(0, 0);
        sim.HandleSequenceKey(0, 1); // progress = 2
        sim.HandleSequenceKey(0, 3); // out of order
        sim.Lane(0).SeqProgress.Should().Be(0);
        sim.Lane(0).Speed.Should().Be(PoSportsConstants.Impulse);

        // A key before the gun holds the runner and resets progress.
        var cold = new PoSportsSim([new PoSportsSim.LaneSetup("Alice", "kim", IsAi: false)], seed: 1);
        cold.HandleSequenceKey(0, 0);
        cold.Phase.Should().Be("countdown");
        cold.Lane(0).SeqProgress.Should().Be(0);
        cold.Lane(0).HoldRemaining.Should().BeApproximately(PoSportsConstants.FalseStartHold, 1e-9);
    }

    [Fact]
    public void Hurdles_AirborneClears_GroundedStumbles()
    {
        // Airborne over the 20 m hurdle: no penalty, position keeps advancing.
        var sim = StartedSim();
        sim.AdvanceToHurdlesLeg();
        sim.Lane(0).Position = 19.5;
        sim.Lane(0).Speed = 8.0;
        sim.HandleJump(0);
        var before = sim.Lane(0).LegTime;
        for (var i = 0; i < 12; i++) sim.Tick(Dt); // 0.2 s — crosses 20 m airborne
        sim.Lane(0).Position.Should().BeGreaterThan(20);
        sim.Lane(0).LegTime.Should().BeApproximately(before + 0.2, 0.005,
            "an airborne clear adds no stumble penalty");

        // Grounded hit: speed × StumbleFactor, legTime + StumblePenalty.
        var sim2 = StartedSim();
        sim2.AdvanceToHurdlesLeg();
        sim2.Lane(0).Position = 19.5;
        sim2.Lane(0).Speed = 8.0;
        var before2 = sim2.Lane(0).LegTime;
        for (var i = 0; i < 12; i++) sim2.Tick(Dt);
        var decayed = 8.0 * Math.Pow(PoSportsConstants.Decay, 0.2);
        sim2.Lane(0).Speed.Should().BeLessThan(decayed * PoSportsConstants.StumbleFactor * 1.1);
        sim2.Lane(0).LegTime.Should().BeApproximately(before2 + 0.2 + PoSportsConstants.StumblePenalty, 0.01);
    }

    [Fact]
    public void MeetFlow_Interstitial_Podium_And_Snapshot()
    {
        // Sprint leg done → 8 s interstitial → hurdles leg with lanes reset.
        var sim = StartedSim();
        CompleteSequence(sim, 0);
        sim.Tick(Dt);

        var snap = sim.Snapshot();
        snap.Phase.Should().Be("sprint");
        snap.Lanes.Should().HaveCount(2);
        snap.Lanes[0].Character.Should().Be("kim");
        snap.Lanes[0].Speed.Should().BeGreaterThan(0);
        snap.Lanes[1].IsAi.Should().BeTrue();

        sim.ForceLegFinish(sprint: true);
        sim.Phase.Should().Be("interstitial");
        for (var i = 0; i < (int)(PoSportsConstants.InterstitialSeconds * 60) + 5; i++) sim.Tick(Dt);
        sim.Phase.Should().Be("hurdles");
        sim.Lane(0).Position.Should().Be(0, "lanes reset to the start line for leg 2");
        sim.Lane(0).SeqProgress.Should().Be(0);

        // Podium ranks by combined total ascending — lane 1 wins on 29.0 vs 32.0.
        var sim2 = StartedSim();
        sim2.ForceMeetResult(sprintSeconds: [12.0, 15.0], hurdlesSeconds: [20.0, 14.0]);
        sim2.Phase.Should().Be("podium");
        sim2.Lane(1).Placing.Should().Be(1);
        sim2.Lane(0).Placing.Should().Be(2);
    }

    [Fact]
    public void AiOnlyMeet_FinishesWithin180SimSeconds()
    {
        var sim = new PoSportsSim(
        [
            new PoSportsSim.LaneSetup("CPU 1", "kim", IsAi: true),
            new PoSportsSim.LaneSetup("CPU 2", "matt", IsAi: true),
            new PoSportsSim.LaneSetup("CPU 3", "nick", IsAi: true),
            new PoSportsSim.LaneSetup("CPU 4", "tong", IsAi: true),
        ], seed: 7);

        for (var i = 0; i < 180 * 60 && sim.Phase != "podium"; i++) sim.Tick(Dt);

        sim.Phase.Should().Be("podium");
        sim.Lanes.Should().OnlyContain(l => l.SprintSeconds > 0 && l.HurdlesSeconds > 0);
        sim.Lanes.Select(l => l.Placing).Should().BeEquivalentTo([1, 2, 3, 4]);
    }
}
