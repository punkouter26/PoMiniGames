using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// Drives an AI car one tick at a time using look-ahead steering against the
/// centerline. The personality parameter bundle is the same shape as
/// <see cref="PoCabinetPersonality"/> (mirroring PoRacer's parameter structure
/// per ADR-3); each official gets a frozen instance whose values shape the
/// distinct driving lines the E2E-API contract test asserts against.
///
/// <para>
/// The driver itself is stateless — pass it the sim's centerline + the car to
/// step + the tick delta — so it stays deterministic given identical inputs
/// (which is the contract <c>PoCabinetSimDeterminismTests</c> depends on).
/// </para>
/// </summary>
public static class PoCabinetAiDriver
{
    /// <summary>
    /// Apply one AI tick to <paramref name="car"/>. Updates <see cref="PoCabinetSim.SimCar.Speed"/>
    /// and <see cref="PoCabinetSim.SimCar.Heading"/>. Caller is responsible for
    /// collision / wall / lap logic that follows in the sim tick.
    /// </summary>
    public static void Step(
        IReadOnlyList<Vec2> centerline,
        PoCabinetSim.SimCar car,
        PoCabinetPersonality personality,
        double dt)
    {
        if (centerline.Count < 2) return;

        int n = centerline.Count;
        double speedFrac = Math.Clamp(Math.Abs(car.Speed) / car.MaxSpeed, 0, 1);

        // 1. Aim index — a few centerline nodes ahead, scaled by personality lookahead.
        //    Higher speedFrac + higher CorneringSkill look further (PoRacer pattern).
        double lookFactor = personality.LookaheadDistance / 60.0;
        int steerLook = (int)Math.Round((3 + speedFrac * 6 + car.CorneringSkill * 3) * lookFactor);
        int aimIdx = (car.LastCheckpoint + steerLook) % n;
        var target = centerline[aimIdx];

        // 2. Lateral offset — official drives off-center by LateralOffset × (track width / 2).
        //    Steve B. (positive) drives on the outside; Sean S. (negative) hugs the inside.
        var aim = target;
        if (Math.Abs(personality.LateralOffset) > 1e-6)
        {
            var a = centerline[aimIdx];
            var b = centerline[(aimIdx + 1) % n];
            var norm = PoCabinetTrackRegistry.ComputeNormal(a, b);
            // Car width proxy: ~half of typical TrackWidth. Server side, that's 110.
            aim = new Vec2(
                target.X + norm.X * 110 * personality.LateralOffset,
                target.Y + norm.Y * 110 * personality.LateralOffset);
        }

        // 3. Steering — rotate heading toward the aim point. Sharper turn when farther off-axis.
        double dx = aim.X - car.Pos.X;
        double dy = aim.Y - car.Pos.Y;
        double desiredHeading = Math.Atan2(dy, dx);
        double diff = ShortAngleDiff(desiredHeading, car.Heading);
        double steerStrength = personality.BrakingAggression; // aggression also drives turn sharpness
        car.Heading += Math.Clamp(diff, -steerStrength, steerStrength) * Math.Min(1, dt * 4);

        // 4. Throttle — accelerate to a target speed scaled by cornering skill + drafting.
        double targetSpeed = car.MaxSpeed * (0.5 + 0.5 * car.CorneringSkill);
        if (personality.DraftingAffinity > 0)
        {
            // Drafting bot eases up when alone; speeds up when close to another car ahead.
            // For v1 we approximate drafting as: maintain 0.9× max when no one ahead, boost
            // to 1.0× when another car is within 60 world units ahead and roughly aligned.
            bool draft = AnyCarAhead(centerline, car, 60);
            targetSpeed *= draft ? 1.0 : 0.9;
        }
        // Apply throttle (positive only — AI doesn't reverse in v1).
        if (car.Speed < targetSpeed)
        {
            car.Speed = Math.Min(targetSpeed, car.Speed + car.Acceleration * dt);
        }
        else if (car.Speed > targetSpeed * 1.05)
        {
            car.Speed = Math.Max(targetSpeed, car.Speed - car.Acceleration * personality.BrakingAggression * dt);
        }
    }

    /// <summary>True if any other car sits within <paramref name="range"/> world units ahead and roughly aligned.</summary>
    private static bool AnyCarAhead(
        IReadOnlyList<Vec2> centerline,
        PoCabinetSim.SimCar self,
        double range)
    {
        // Caller passes `centerline` and `self`. The full grid isn't passed here; we
        // approximate the drafting check by comparing the car's projection ahead vs.
        // the centerline's curvature — a tight radius means braking is needed; a
        // straight means drafting is plausible. PoRacer's IsDrafting takes two points;
        // for v1 we approximate against self distance only and let the racing service
        // tune this in T7 if it over- or under-drafts.
        return false; // placeholder — drafting detection wired in T7 once the racing service exists
    }

    /// <summary>Shortest signed angular difference a-b, normalised to (-π, π].</summary>
    public static double ShortAngleDiff(double a, double b)
    {
        var diff = (a - b) % (2 * Math.PI);
        if (diff > Math.PI) diff -= 2 * Math.PI;
        if (diff < -Math.PI) diff += 2 * Math.PI;
        return diff;
    }
}
