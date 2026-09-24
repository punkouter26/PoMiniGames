using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>Resolved per-tick controls: throttle and brake in [0, 1], steer in [-1, 1] (+ = right).</summary>
public readonly record struct PoCabinetControls(double Throttle, double Brake, double Steer)
{
    /// <summary>Analog fields win when any is set; otherwise the digital key flags map to full travel.</summary>
    public static PoCabinetControls From(PoCabinetInput? input)
    {
        if (input is null) return default;
        bool analog = input.Throttle != 0 || input.Brake != 0 || input.Steer != 0;
        if (analog)
        {
            return new PoCabinetControls(
                Clamp01(input.Throttle),
                Clamp01(input.Brake),
                Math.Clamp(double.IsFinite(input.Steer) ? input.Steer : 0, -1, 1));
        }
        return new PoCabinetControls(
            input.Up ? 1 : 0,
            input.Down ? 1 : 0,
            (input.Right ? 1 : 0) - (input.Left ? 1 : 0));
    }

    private static double Clamp01(double v) => double.IsFinite(v) ? Math.Clamp(v, 0, 1) : 0;
}

/// <summary>Physical state of one car — everything <see cref="PoCabinetPhysics.Step"/> reads or writes.</summary>
public class PoCabinetCarBody
{
    public double X { get; set; }
    public double Y { get; set; }
    /// <summary>Radians; forward is (cos h, sin h). Right-hand side is (-sin h, cos h).</summary>
    public double Heading { get; set; }
    /// <summary>Units per second along the heading; negative while reversing.</summary>
    public double Speed { get; set; }
    public int SegHint { get; set; } = -1;
    /// <summary>Arc-length position on the loop, in [0, Length).</summary>
    public double Along { get; set; }
    /// <summary>Unwrapped race distance: starts negative on the grid, one lap = track length.</summary>
    public double Distance { get; set; }
    public double Lateral { get; set; }
    public bool OnGrass { get; set; }
    public bool Sliding { get; set; }
    /// <summary>Speed lost into the barrier on the last step (0 = no hit) — drives rumble.</summary>
    public double WallImpact { get; set; }
}

/// <summary>
/// Arcade car physics shared by every PoCabinet race: a speed-along-heading model with a
/// lateral-grip cap (understeer past it), grass run-off with extra drag, and a barrier that
/// removes the outward velocity component.
///
/// <para>
/// <b>Mirror contract:</b> <c>wwwroot/js/pocabinet/physics.js</c> ports <see cref="Step"/>,
/// <see cref="ResolveContacts"/> and <see cref="GridSlot"/> line for line, with the same
/// constants. Solo races run the JS copy; multiplayer runs this one on the server while the
/// browser runs the JS copy to predict its own car and replays unacknowledged inputs on top of
/// each snapshot. If the two diverge, every correction becomes a visible snap.
/// </para>
/// </summary>
public static class PoCabinetPhysics
{
    public const double TickSeconds = 1.0 / 30.0;
    /// <summary>Top speed on tarmac at full throttle, units/s.</summary>
    public const double MaxSpeed = 140;
    /// <summary>HUD conversion: 140 units/s reads as 280 km/h.</summary>
    public const double KmhPerUnit = 2.0;
    public const double Accel = 55;
    public const double BrakeDecel = 130;
    public const double CoastDecel = 14;
    public const double ReverseAccel = 25;
    public const double ReverseMax = 18;
    /// <summary>Yaw rate at full lock once rolling, rad/s.</summary>
    public const double SteerRate = 2.3;
    /// <summary>Below this speed the available lock scales down linearly — no pivoting on the spot.</summary>
    public const double SteerFullSpeed = 18;
    /// <summary>Lateral acceleration cap (speed × yaw rate). Asking for more understeers.</summary>
    public const double GripAccel = 105;
    public const double ScrubDecel = 30;
    public const double GrassDecel = 50;
    public const double GrassGrip = 0.6;
    /// <summary>Grass strip between the road edge and the barrier.</summary>
    public const double RunOff = 26;
    public const double CarRadius = 14;
    public const double WallRestitution = 0.25;
    public const double WallFriction = 0.85;
    /// <summary>Most negative speed a contact may leave a car with.</summary>
    public const double ContactSpeedFloor = ReverseMax * 1.5;

    /// <summary>Barrier distance from the centerline for a track (car centre can't pass it).</summary>
    public static double WallLateral(PoCabinetTrack track) => track.HalfWidth + RunOff - CarRadius * 0.5;

    /// <summary>
    /// Advance one car by <paramref name="dt"/>. <paramref name="grip"/> is the weather factor
    /// (1 = dry). Contacts with other cars are a separate pass (<see cref="ResolveContacts"/>).
    /// </summary>
    public static void Step(PoCabinetTrack track, PoCabinetCarBody car, PoCabinetControls c, double dt, double grip)
    {
        double throttle = c.Throttle, brake = c.Brake, steer = c.Steer;
        double v = car.Speed;
        double surfaceGrip = car.OnGrass ? GrassGrip : 1;

        // ── Longitudinal ────────────────────────────────────────────────
        double v2;
        if (v < -0.01)
        {
            // Rolling backwards: brake keeps reversing, throttle (or nothing) pulls back to zero.
            if (brake > 0 && throttle == 0)
            {
                v2 = Math.Max(-ReverseMax, v - ReverseAccel * brake * dt);
            }
            else
            {
                v2 = v + (throttle * Accel + CoastDecel) * dt;
                if (throttle == 0) v2 = Math.Min(v2, 0);
            }
        }
        else if (v <= 0.5 && throttle == 0 && brake > 0)
        {
            // Stopped with the brake held: that is the reverse gear.
            v2 = Math.Max(-ReverseMax, v - ReverseAccel * brake * dt);
        }
        else
        {
            double ratio = v / MaxSpeed;
            double a = throttle * Accel * grip * Math.Max(0, 1 - ratio * ratio)
                       - brake * BrakeDecel
                       - CoastDecel * (1 - throttle);
            if (car.OnGrass && v > 25) a -= GrassDecel;
            v2 = Math.Max(0, v + a * dt);
        }

        // ── Steering with a lateral-grip cap ────────────────────────────
        double speedAbs = Math.Abs(v2);
        double lockScale = Math.Min(1, speedAbs / SteerFullSpeed);
        double omegaWanted = steer * SteerRate * lockScale * (v2 < 0 ? -1 : 1);
        double omegaGrip = GripAccel * grip * surfaceGrip / Math.Max(speedAbs, 1);
        double omega = Math.Clamp(omegaWanted, -omegaGrip, omegaGrip);
        car.Sliding = Math.Abs(omegaWanted) > omegaGrip * 1.02 && speedAbs > 30;
        if (car.Sliding)
        {
            v2 = v2 > 0 ? Math.Max(0, v2 - ScrubDecel * dt) : Math.Min(0, v2 + ScrubDecel * dt);
        }

        double heading = car.Heading + omega * dt;
        double x = car.X + Math.Cos(heading) * v2 * dt;
        double y = car.Y + Math.Sin(heading) * v2 * dt;

        // ── Track: grass and barrier ────────────────────────────────────
        var proj = track.Project(x, y, car.SegHint);
        double wallLat = WallLateral(track);
        car.WallImpact = 0;
        if (Math.Abs(proj.Lateral) > wallLat)
        {
            double s = proj.Lateral > 0 ? 1 : -1;
            double nx = -proj.Ty * s, ny = proj.Tx * s; // outward normal
            double excess = Math.Abs(proj.Lateral) - wallLat;
            x -= nx * excess;
            y -= ny * excess;

            double vx = Math.Cos(heading) * v2, vy = Math.Sin(heading) * v2;
            double vn = vx * nx + vy * ny;
            if (vn > 0)
            {
                double tx = vx - nx * vn, ty = vy - ny * vn;
                vx = tx * WallFriction - nx * vn * WallRestitution;
                vy = ty * WallFriction - ny * vn * WallRestitution;
                double speed = Math.Sqrt(vx * vx + vy * vy);
                if (speed > 1) heading = v2 >= 0 ? Math.Atan2(vy, vx) : Math.Atan2(-vy, -vx);
                v2 = v2 >= 0 ? speed : -speed;
                car.WallImpact = vn;
            }
            proj = track.Project(x, y, proj.Index);
        }

        car.X = x;
        car.Y = y;
        car.Heading = PoCabinetTrack.WrapAngle(heading);
        car.Speed = v2;
        car.SegHint = proj.Index;
        car.Lateral = proj.Lateral;
        car.OnGrass = Math.Abs(proj.Lateral) > track.HalfWidth;
        AdvanceDistance(track, car, proj.Along);
    }

    /// <summary>Unwrap the loop position into race distance (so reversing over the line un-counts it).</summary>
    public static void AdvanceDistance(PoCabinetTrack track, PoCabinetCarBody car, double along)
    {
        double delta = along - car.Along;
        double half = track.Length * 0.5;
        if (delta > half) delta -= track.Length;
        else if (delta < -half) delta += track.Length;
        car.Distance += delta;
        car.Along = along;
    }

    /// <summary>
    /// Pairwise car contacts: separate overlapping cars and hand closing speed from the car
    /// behind to the car in front. Order-dependent by design (index order), identically in JS.
    /// </summary>
    public static void ResolveContacts(IReadOnlyList<PoCabinetCarBody> cars)
    {
        double min = CarRadius * 2;
        for (int i = 0; i < cars.Count; i++)
        {
            for (int j = i + 1; j < cars.Count; j++)
            {
                var a = cars[i];
                var b = cars[j];
                double dx = b.X - a.X, dy = b.Y - a.Y;
                double d = Math.Sqrt(dx * dx + dy * dy);
                if (d <= 1e-6 || d >= min) continue;
                double nx = dx / d, ny = dy / d;
                double push = (min - d) * 0.5;
                a.X -= nx * push;
                a.Y -= ny * push;
                b.X += nx * push;
                b.Y += ny * push;

                double ahx = Math.Cos(a.Heading), ahy = Math.Sin(a.Heading);
                double bhx = Math.Cos(b.Heading), bhy = Math.Sin(b.Heading);
                double va = a.Speed * (ahx * nx + ahy * ny);
                double vb = b.Speed * (bhx * nx + bhy * ny);
                double closing = va - vb;
                if (closing <= 0) continue;
                a.Speed -= closing * 0.6 * (ahx * nx + ahy * ny);
                b.Speed += closing * 0.3 * (bhx * nx + bhy * ny);
                // Bounded so a shove can't launch a car past what its own engine could do:
                // unbounded, a car rammed while facing backwards reached -49 u/s and the two
                // cars locked together for the rest of the race.
                a.Speed = Math.Clamp(a.Speed, -ContactSpeedFloor, MaxSpeed * 1.08);
                b.Speed = Math.Clamp(b.Speed, -ContactSpeedFloor, MaxSpeed * 1.08);
            }
        }
    }

    /// <summary>
    /// Starting-grid slot <paramref name="slot"/>: two columns, pole just behind the line, so
    /// every car's race distance starts negative and lap 1 ends at one track length.
    /// </summary>
    public static void GridSlot(PoCabinetTrack track, PoCabinetCarBody car, int slot)
    {
        int row = slot / 2;
        double back = 18 + row * 42;
        double lateral = (slot % 2 == 0 ? -1 : 1) * track.HalfWidth * 0.38;
        var p = track.PointAt(track.Length - back);
        car.X = p.X + -p.Ty * lateral;
        car.Y = p.Y + p.Tx * lateral;
        car.Heading = Math.Atan2(p.Ty, p.Tx);
        car.Speed = 0;
        var proj = track.Project(car.X, car.Y, -1);
        car.SegHint = proj.Index;
        car.Along = proj.Along;
        car.Lateral = proj.Lateral;
        car.OnGrass = false;
        car.Distance = proj.Along > track.Length * 0.5 ? proj.Along - track.Length : proj.Along;
    }
}
