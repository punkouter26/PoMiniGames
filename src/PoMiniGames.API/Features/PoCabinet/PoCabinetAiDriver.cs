namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// Picks controls for an AI official each tick: aim at a point ahead on the centerline,
/// offset to the lane it wants, and hold a speed the next corner and the car ahead allow.
/// The AI drives through the same <see cref="PoCabinetPhysics.Step"/> as a player — it gets
/// throttle/brake/steer, never a position — so it obeys grip, grass and barriers.
///
/// <para>
/// Personality shapes the driving, not the physics: <c>LateralOffset</c> is the lane it holds,
/// <c>LookaheadDistance</c> how early it turns in, <c>BrakingAggression</c> how late and how
/// hard it brakes for a corner, <c>CollisionTolerance</c> how much it insists on its own line
/// in traffic, <c>DraftingAffinity</c> how keenly it tucks in behind a car,
/// <c>Wildness</c> how often it overcooks a corner and runs off the road (<see cref="Lapse"/>),
/// <c>Aggression</c> how it treats the car ahead and alongside (a bruiser follows close
/// enough to bump and turns in on a car beside it) and <c>Twitch</c> how hard it saws at the
/// wheel. A wrecked car is driven off the racing line instead (<see cref="Wrecked"/>).
/// </para>
/// <para>
/// Traffic (built for the 100-car solo field) is three rules: follow the car in
/// its path no faster than it can still brake down to that car's speed; take the lane with the
/// longest clear run ahead; never turn in on a car alongside. Watching only the nearest car
/// ahead by race distance is something five cars survive and a hundred do not.
/// </para>
/// <para>
/// Deterministic; the only state is per-thread scratch. <c>wwwroot/js/pocabinet/physics.js</c>
/// (<c>aiControls</c>) is the browser port the solo race and the demo autopilot use.
/// </para>
/// </summary>
public static class PoCabinetAiDriver
{
    /// <summary>Gap it keeps to the car ahead (centres; hulls touch at 39) and the braking it plans on.</summary>
    private const double FollowGap = 44;
    private const double FollowDecel = 80;
    /// <summary>How far up the road it looks for traffic.</summary>
    private const double Range = 170;
    /// <summary>A driver's lapses are drawn once per stretch of road this long, and last this far into it.</summary>
    private const double LapseStretch = 380;
    private const double LapseLength = 170;
    /// <summary>How far over its own pace a car lets a descent carry it before it brakes for it.</summary>
    private const double RunOn = 30;

    // Scratch for one Decide call: the cars ahead that are in the way, and how far ahead each is.
    [ThreadStatic] private static PoCabinetCarBody[]? _near;
    [ThreadStatic] private static double[]? _nearGap;

    public static PoCabinetControls Decide(
        PoCabinetTrack track,
        PoCabinetCarBody car,
        PoCabinetPersonality personality,
        double maxSpeed,
        double corneringSkill,
        PoCabinetCarBody[] field,
        double grip)
    {
        if (car.Wrecked) return Wrecked(track, car);
        double v = car.Speed;
        double hw = track.HalfWidth;
        double edge = hw * 0.8;
        double line = personality.LateralOffset * hw * 0.6;
        double lateralTarget = line;

        // Traffic. What is in the way (the car to follow, a car alongside) is judged in this
        // car's own frame, from where the two actually are: the centerline has kinks tighter
        // than a car, and across one of those "ahead on the road" is noise that parked a whole
        // field behind a car that was beside it. Lanes are a road notion, so the lane choice
        // reads road positions: the nearest car ahead, and the ones not pulling away.
        var near = _near;
        var nearGap = _nearGap;
        if (near is null || nearGap is null || near.Length < field.Length)
        {
            _near = near = new PoCabinetCarBody[Math.Max(16, field.Length)];
            _nearGap = nearGap = new double[near.Length];
        }
        double half = track.Length * 0.5;
        double hx = PoCabinetTrack.Cos(car.Heading), hy = PoCabinetTrack.Sin(car.Heading);
        PoCabinetCarBody? ahead = null, blocker = null;
        double gap = double.MaxValue, blockGap = double.MaxValue;
        bool left = false, right = false;
        int count = 0;
        for (int i = 0; i < field.Length; i++)
        {
            var other = field[i];
            if (ReferenceEquals(other, car)) continue;
            // Along the road first: it wraps the lap (a lapped or cooling-down car counts) and
            // drops the other level of a crossing.
            double d = other.Along - car.Along;
            if (d > half) d -= track.Length;
            else if (d < -half) d += track.Length;
            if (d <= -Range || d >= Range || track.Parked(other.Distance)) continue;
            double dx = other.X - car.X, dy = other.Y - car.Y;
            double fwd = dx * hx + dy * hy, side = dy * hx - dx * hy;
            if (fwd > -44 && fwd < 44)
            {
                if (side > 12 && side < 30) right = true;
                else if (side < -12 && side > -30) left = true;
            }
            // In its path AND ahead of it on the road: two cars converging at an angle are each
            // in the other's path, and without the second test both wait for the other forever.
            // A wreck is never followed: it is not going anywhere, so it is a lane to avoid (below).
            if (d > 0 && fwd > 4 && fwd < blockGap && Math.Abs(side) < 20 && !other.Wrecked)
            {
                blockGap = fwd;
                blocker = other;
            }
            if (d <= 4) continue;
            if (d < gap && !other.Wrecked)
            {
                gap = d;
                ahead = other;
            }
            if (other.Speed < v + 4)
            {
                near[count] = other;
                nearGap[count] = d;
                count++;
            }
        }
        if (ahead is not null && personality.DraftingAffinity > 0.5 && gap > 50)
        {
            lateralTarget = ahead.Lateral; // tuck into the slipstream
        }
        else if (count > 0)
        {
            // Pick a lane: its own line and seven across the tarmac, scored by the clear road
            // ahead, less how far the lane is from its line (a tolerant driver insists on its
            // line) and from where the car is now (which keeps the choice from flickering).
            double own = 0.2 + 0.6 * personality.CollisionTolerance;
            double best = ClearRun(near, nearGap, count, line) - Math.Abs(line - car.Lateral) * 0.25;
            for (int k = -3; k <= 3; k++)
            {
                double lane = edge * k / 3;
                double score = ClearRun(near, nearGap, count, lane) - Math.Abs(lane - line) * own - Math.Abs(lane - car.Lateral) * 0.25;
                if (score > best)
                {
                    best = score;
                    lateralTarget = lane;
                }
            }
        }
        lateralTarget = Math.Min(edge, Math.Max(-edge, lateralTarget));
        // A lapse: off its line and out over the edge of the road.
        double lapsing = Lapse(personality, car.Distance);
        if (lapsing != 0) lateralTarget = lapsing > 0 ? hw + PoCabinetPhysics.RunOff * 0.6 : -(hw + PoCabinetPhysics.RunOff * 0.6);
        // Never turn in on a car that is alongside: hold the lane (but always come back off the
        // grass). A bruiser does it anyway and leans on whoever is there.
        if (personality.Aggression < 0.8 && (lateralTarget > car.Lateral ? right : left)) lateralTarget = Math.Min(edge, Math.Max(-edge, car.Lateral));

        // Steering: aim at a point ahead, further ahead at speed.
        double look = personality.LookaheadDistance * 0.5 + 20 + Math.Abs(v) * 0.45;
        var p = track.PointAt(car.Along + look);
        double tx = p.X + -p.Ty * lateralTarget;
        double ty = p.Y + p.Tx * lateralTarget;
        double desired = PoCabinetTrack.Atan2(ty - car.Y, tx - car.X);
        double err = PoCabinetTrack.WrapAngle(desired - car.Heading);
        // A smooth driver feeds the lock in; a twitchy one saws at it and weaves.
        double steer = Math.Min(1, Math.Max(-1, err * (1.8 + 1.6 * personality.Twitch)));
        if (v < 0) steer = -steer; // rolling backwards inverts the lock (see PoCabinetPhysics.Step)

        // Speed: the tightest corner in braking range sets the target. Capped at a turn as tight
        // as the road is wide: the centerline has kinks sharper than that (Mar-a-Lago's last
        // bend, a few samples long) which a car simply cuts across, and braking for them parked
        // a 100-car field on the start line.
        // A late braker looks 0.7 s up the road for its corner, a cautious one 1.3 s; either
        // way a lapse has it believing in grip that is not there.
        double margin = (0.55 + corneringSkill * 0.4) * (lapsing != 0 ? Math.Abs(lapsing) : 1);
        double kappa = Math.Min(1 / track.HalfWidth, track.MaxCurvature(car.Along + 5, car.Along + 30 + Math.Abs(v) * (1.3 - 0.6 * personality.BrakingAggression)));
        double cornerSpeed = Math.Sqrt(PoCabinetPhysics.GripAccel * grip * margin / Math.Max(kappa, 1e-5));
        double target = Math.Min(maxSpeed, cornerSpeed);
        // What it brakes for: the corner and the traffic. Its own pace it only lifts for, so a
        // descent can carry it on, up to RunOn over (a finished car parking, at 0, stops).
        double limit = Math.Min(cornerSpeed, maxSpeed > 0 ? maxSpeed + RunOn : 0);
        if (blocker is not null)
        {
            // The car ahead in this lane: no faster than can still be braked down to its speed
            // in the room there is, and a little under it once nose to tail. Never negative:
            // brake at a standstill is the reverse gear. An aggressive driver follows closer than
            // the cars are long, and bumps.
            double room = blockGap - (FollowGap - 12 * personality.Aggression);
            double vb = Math.Max(0, blocker.Speed);
            double follow = room > 0 ? Math.Sqrt(vb * vb + 2 * FollowDecel * room) : Math.Max(0, vb - 15);
            target = Math.Min(target, follow);
            limit = Math.Min(limit, follow);
        }

        double throttle = v < target - 3 ? 1 : v < target ? 0.35 : 0;
        double brake = v > limit + 4
            ? Math.Min(1, Math.Max(0.15, (v - limit) / 18 * (0.6 + personality.BrakingAggression * 0.8)))
            : 0;
        return new PoCabinetControls(throttle, brake, steer);
    }

    /// <summary>
    /// A wrecked car's driver: get it off the racing line to the barrier on the side it is
    /// nearer, on what limp the engine has left (<see cref="PoCabinetPhysics.Step"/> caps it),
    /// then stop it there. Mirrors physics.js <c>wreckControls</c>.
    /// </summary>
    public static PoCabinetControls Wrecked(PoCabinetTrack track, PoCabinetCarBody car)
    {
        double v = car.Speed;
        double target = (car.Lateral < 0 ? -1 : 1) * (track.HalfWidth + PoCabinetPhysics.RunOff * 0.7);
        var p = track.PointAt(car.Along + 30 + Math.Abs(v) * 0.3);
        double tx = p.X + -p.Ty * target;
        double ty = p.Y + p.Tx * target;
        double steer = Math.Min(1, Math.Max(-1, PoCabinetTrack.WrapAngle(PoCabinetTrack.Atan2(ty - car.Y, tx - car.X) - car.Heading) * 2.4));
        if (v < 0) steer = -steer;
        bool clear = Math.Abs(car.Lateral) > track.HalfWidth + PoCabinetPhysics.WreckClear;
        return new PoCabinetControls(clear ? 0 : 1, clear && v > 0.5 ? 0.6 : 0, steer);
    }

    /// <summary>
    /// A driver's lapse: 0 while it is driving properly, else how far over the limit it thinks
    /// the grip goes (1.5 to 2.4 times), signed by the side of the road it is about to leave
    /// (+ = right). While it lasts the car misses its line, runs wide onto the run-off on that
    /// side and carries too much speed into whatever corner is next; then it gathers it up.
    /// One draw per <see cref="LapseStretch"/> of race distance, live for the first
    /// <see cref="LapseLength"/> of it and never off the grid: a pure hash of the driver's seed
    /// and the stretch. No state, no RNG, integer and exact double arithmetic only, so the
    /// browser and the lap verifier draw the same lapses. Mirrors physics.js <c>lapse</c>.
    /// </summary>
    private static double Lapse(PoCabinetPersonality personality, double distance)
    {
        if (!(personality.Wildness > 0) || distance < LapseStretch) return 0;
        double at = distance + personality.Seed * 53;
        double stretch = Math.Floor(at / LapseStretch);
        if (at - stretch * LapseStretch > LapseLength) return 0;
        unchecked
        {
            uint h = ((uint)(int)stretch ^ ((uint)personality.Seed * 0x9E3779B1u)) * 0x85EBCA6Bu;
            h ^= h >> 13;
            h *= 0xC2B2AE35u;
            h ^= h >> 16;
            if ((h & 0xffff) / 65535.0 >= personality.Wildness) return 0;
            double over = 1.5 + ((h >> 16) & 0xff) / 255.0 * 0.9;
            return h >> 31 != 0 ? over : -over;
        }
    }

    /// <summary>Clear road ahead in lane <paramref name="lateral"/> (capped at <see cref="Range"/>).</summary>
    private static double ClearRun(PoCabinetCarBody[] near, double[] nearGap, int count, double lateral)
    {
        double run = Range;
        for (int i = 0; i < count; i++)
        {
            if (nearGap[i] < run && Math.Abs(near[i].Lateral - lateral) < 20) run = nearGap[i];
        }
        return run;
    }
}
