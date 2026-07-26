using System.Diagnostics;
using PoShared.Games;

namespace PoMiniGames.Features.PoRacer;

/// <summary>
/// Plain-CLR PoRacer simulation engine — NO SignalR, NO Blazor, NO JS. The
/// <see cref="PoRacerRaceService"/> drives it on a timer and broadcasts the
/// snapshot. This is where every physics tick lives; the client renders the
/// same payload it receives, period.
/// </summary>
internal sealed class PoRacerSim
{
    private const int TotalLaps = 3;
    private const double CarRadius = 18;
    private const double StopAfterMs = 90_000; // 90s safety cap so a stuck client can't hang the room
    // Once the winner crosses the line (finishes lap 3), the pack gets this much
    // longer to finish; then the race ends and stragglers are DNF'd. Keeps the
    // race from idling to the 90 s cap after it's effectively decided.
    private const double FinishGraceMs = 5_000;
    private double _leaderFinishMs = -1;

    public PoRacerStaticWorld Static { get; }

    // Track
    private readonly List<Vec2> _centerline = new();
    private readonly List<(Vec2 a, Vec2 b)> _walls = new();
    private readonly double _trackWidth;

    // Cars + input map
    private readonly List<SimCar> _cars = new();
    private readonly Dictionary<string, SimCar> _byConnectionId = new(StringComparer.Ordinal);

    private readonly Stopwatch _wallClock = Stopwatch.StartNew();
    private long _startElapsedMs;

    public PoRacerSim(IReadOnlyList<PoRacerLobbyPlayer> players)
    {
        // Track is identical to the existing in-browser track (same control points
        // → same Catmull-Rom resampling). Keeping the constants in one place
        // avoids drift between the server's collision math and the client visual.
        var raw = new (double x, double y)[]
        {
            (0,    0),
            (600,  -120),
            (1200, -300),
            (1700, -200),
            (2050,  120),
            (2050,  520),
            (1700,  800),
            (1100,  900),
            (500,   820),
            (-50,   700),
            (-350,  400),
            (-350,  100),
            (-150, -150)
        };
        _trackWidth = 240;
        _centerline.Clear();
        _walls.Clear();
        var pts = raw.Select(p => new Vec2(p.x, p.y)).ToList();
        foreach (var p in ResampleClosedSpline(pts, 12))
        {
            _centerline.Add(p);
        }
        for (int i = 0; i < _centerline.Count; i++)
        {
            var a = _centerline[i];
            var b = _centerline[(i + 1) % _centerline.Count];
            var n = Normal(a, b);
            var hw = _trackWidth * 0.5;
            _walls.Add((new Vec2(a.X - n.X * hw, a.Y - n.Y * hw), new Vec2(b.X - n.X * hw, b.Y - n.Y * hw)));
            _walls.Add((new Vec2(a.X + n.X * hw, a.Y + n.Y * hw), new Vec2(b.X + n.X * hw, b.Y + n.Y * hw)));
        }

        // Build flat typed-array payloads for the wire format.
        var centerArr = new double[_centerline.Count * 2];
        for (int i = 0; i < _centerline.Count; i++)
        {
            centerArr[i * 2] = _centerline[i].X;
            centerArr[i * 2 + 1] = _centerline[i].Y;
        }
        var wallsArr = new double[_walls.Count * 4];
        for (int i = 0; i < _walls.Count; i++)
        {
            wallsArr[i * 4] = _walls[i].a.X;
            wallsArr[i * 4 + 1] = _walls[i].a.Y;
            wallsArr[i * 4 + 2] = _walls[i].b.X;
            wallsArr[i * 4 + 3] = _walls[i].b.Y;
        }
        double minX = double.MaxValue, minY = double.MaxValue, maxX = double.MinValue, maxY = double.MinValue;
        foreach (var p in _centerline)
        {
            if (p.X < minX) minX = p.X; if (p.X > maxX) maxX = p.X;
            if (p.Y < minY) minY = p.Y; if (p.Y > maxY) maxY = p.Y;
        }
        var pad = _trackWidth;
        Static = new PoRacerStaticWorld
        {
            CenterXY = centerArr,
            WallsXY = wallsArr,
            TrackWidth = _trackWidth,
            MinX = minX - pad,
            MinY = minY - pad,
            MaxX = maxX + pad,
            MaxY = maxY + pad,
            TotalLaps = TotalLaps,
        };

        // Spawn grid: 2 cols × N rows along the first segment direction.
        var startA = _centerline[0];
        var startB = _centerline[1];
        // Use a tangent directly: tangent = (b - a) normalized
        var dx = startB.X - startA.X; var dy = startB.Y - startA.Y;
        var dlen = Math.Sqrt(dx * dx + dy * dy);
        var tx = dx / dlen; var ty = dy / dlen;
        // perp = (-ty, tx) — but we also want forward = (tx, ty)
        var nrm = new Vec2(-ty, tx);
        // Player goes first (slot 0). Then 7 AI bots fill the rest.
        var palette = new[] { "#4ec3ff", "#ff5d6c", "#ffd24e", "#7eff8a", "#c47bff", "#ff944d", "#5ee7ff", "#ff77c8" };
        var profiles = new (double skill, double maxSpeed, double accel, double handling)[]
        {
            (0.7, 320, 220, 1.0),
            (0.55, 335, 235, 0.95),
            (0.9, 305, 200, 1.05),
            (0.6, 320, 215, 1.0),
            (0.95, 295, 195, 1.1),
            (0.5, 340, 245, 0.92),
            (0.65, 315, 215, 1.0),
            (0.85, 310, 210, 1.05),
        };
        // Pad players to 8 with AI bots.
        var slots = new List<(string connectionId, string name, bool isPlayer)>();
        foreach (var p in players)
        {
            slots.Add((p.ConnectionId, p.DisplayName, true));
        }
        string[] botNames = { "Vega", "Kairo", "Nyx", "Rocco", "Sable", "Jinx", "Echo", "Astra" };
        // Capture the human count ONCE: slots.Count grows as bots are added, so using
        // it live made `botNames[i - slots.Count]` always index 0 → every bot "Vega".
        int humanCount = slots.Count;
        for (int i = humanCount; i < 8 && i - humanCount < botNames.Length; i++)
        {
            slots.Add(($"bot-{i}", botNames[i - humanCount], false));
        }
        while (slots.Count < 8) slots.Add(($"bot-{slots.Count}", botNames[slots.Count % botNames.Length], false));

        for (int i = 0; i < slots.Count && i < 8; i++)
        {
            var s = slots[i];
            var prof = profiles[i];
            int row = i / 2;
            int col = i % 2;
            double fwdOffset = 60 + row * 38;
            double sideOffset = (col == 0 ? -28.0 : 28.0) - (row * 4);
            var pos = new Vec2(
                startA.X + tx * fwdOffset + nrm.X * sideOffset,
                startA.Y + ty * fwdOffset + nrm.Y * sideOffset);
            var car = new SimCar
            {
                Id = i,
                ConnectionId = s.connectionId,
                Name = s.name,
                IsPlayer = s.isPlayer,
                Color = palette[i],
                ColorDark = Darken(palette[i]),
                Pos = pos,
                Heading = Math.Atan2(ty, tx),
                MaxSpeed = prof.maxSpeed,
                Acceleration = prof.accel,
                Handling = prof.handling,
                CorneringSkill = prof.skill,
                Lap = 1,
                LastCheckpoint = 0,
                CheckpointT = 0,
                DistanceAlongTrack = 0,
            };
            _cars.Add(car);
            if (s.isPlayer) _byConnectionId[s.connectionId] = car;
        }

        _startElapsedMs = _wallClock.ElapsedMilliseconds;
    }

    public bool OwnedBy(string connectionId) => _byConnectionId.ContainsKey(connectionId);

    /// <summary>Called when the countdown reaches GO. Rebases the race clock so elapsed
    /// and finish times start from zero — the sim isn't ticked during the countdown.</summary>
    public void StartRacing()
    {
        _startElapsedMs = _wallClock.ElapsedMilliseconds;
        // Rebase every car's lap timer to the freshly-zeroed race clock so lap 1
        // isn't credited with the countdown time.
        foreach (var c in _cars) c.LapStartElapsed = 0;
    }

    public void Tick(double dt, IReadOnlyDictionary<string, PoRacerInput> inputs)
    {
        // Apply player input.
        foreach (var (cid, car) in _byConnectionId)
        {
            if (!inputs.TryGetValue(cid, out var inp)) continue;
            ApplyControl(car, dt, inp.Up, inp.Down, inp.Left, inp.Right, inp.Space);
        }
        // AI.
        foreach (var c in _cars)
        {
            if (c.IsPlayer) continue;
            if (c.Lap > TotalLaps) continue;
            UpdateAi(c, dt);
        }
        // Finished cars coast to a halt just past the line instead of being driven,
        // so they don't mill around the finish under collision impulses.
        foreach (var c in _cars)
        {
            if (c.Lap <= TotalLaps) continue;
            c.Speed *= Math.Max(0, 1 - 3.5 * dt);
            if (Math.Abs(c.Speed) < 2) c.Speed = 0;
            c.Pos = new Vec2(c.Pos.X + Math.Cos(c.Heading) * c.Speed * dt,
                             c.Pos.Y + Math.Sin(c.Heading) * c.Speed * dt);
        }
        // Car-car collisions.
        ResolveCarCollisions();
        // Hard safety bound: collision impulses on a jam of stopped cars could
        // otherwise integrate into absurd runaway speeds (the finish-line pile-up).
        foreach (var c in _cars) c.Speed = Math.Clamp(c.Speed, -c.MaxSpeed, c.MaxSpeed);
        // Project onto centerline.
        foreach (var c in _cars) Project(c);
        // Wall collisions.
        foreach (var c in _cars) ResolveWallCollision(c);
        // Lap detection + finish time.
        foreach (var c in _cars) UpdateRaceProgress(c);
        // Rank.
        Rank();

        // Race-end: the winner has crossed the line → start the finish grace.
        // When the grace expires (or the 90 s safety cap hits) declare any car
        // still running as DNF, so the race ends when the 3rd lap is won rather
        // than idling on until the cap.
        var elapsed = _wallClock.ElapsedMilliseconds - _startElapsedMs;
        if (_leaderFinishMs < 0 && _cars.Any(c => c.Lap > TotalLaps))
        {
            _leaderFinishMs = elapsed;
        }
        var graceExpired = _leaderFinishMs >= 0 && elapsed - _leaderFinishMs > FinishGraceMs;
        if ((elapsed > StopAfterMs || graceExpired) && !_cars.All(c => c.Lap > TotalLaps))
        {
            foreach (var c in _cars)
            {
                if (c.Lap <= TotalLaps && c.FinishTime < 0)
                {
                    c.FinishTime = double.PositiveInfinity;
                }
            }
        }
    }

    private void ApplyControl(SimCar c, double dt, bool accel, bool brake, bool left, bool right, bool handbrake)
    {
        double steerInput = (right ? 1 : 0) - (left ? 1 : 0);
        double steerRate = 3.0 * c.Handling;
        double maxSteer = 0.55;
        c.Steer += (steerInput - c.Steer / maxSteer) * steerRate * dt;
        c.Steer = Math.Clamp(c.Steer, -maxSteer, maxSteer);
        if (steerInput == 0) c.Steer *= Math.Max(0, 1 - 2.0 * dt);

        double engine = 0;
        if (accel) engine += c.Acceleration;
        if (brake)
        {
            if (c.Speed > 1) engine -= c.Acceleration * 1.6;
            else engine -= c.Acceleration * 0.6;
        }
        c.Speed += engine * dt;
        double drag = 0.6 + Math.Abs(c.Speed) * 0.004;
        c.Speed -= Math.Sign(c.Speed) * drag * dt;
        if (Math.Abs(c.Speed) < 0.5 && !accel && !brake) c.Speed = 0;
        if (handbrake) c.Speed *= Math.Max(0, 1 - 3.0 * dt);
        c.Speed = Math.Clamp(c.Speed, -c.MaxSpeed * 0.4, c.MaxSpeed);

        double speedFactor = Math.Min(1, Math.Abs(c.Speed) / 80);
        double turnRate = (c.Speed / 60.0) * c.Steer * (1.0 - 0.3 * speedFactor);
        double desiredHeading = c.Heading + turnRate * dt;
        bool drifting = handbrake || (Math.Abs(c.Steer) > 0.35 && Math.Abs(c.Speed) > c.MaxSpeed * 0.55);
        if (drifting)
        {
            double slideStrength = handbrake ? 0.7 : 0.4;
            c.Heading = desiredHeading * (1 - slideStrength) + c.Heading * slideStrength;
            c.SkidIntensity = Math.Min(1, c.SkidIntensity + dt * 4);
        }
        else
        {
            c.Heading = desiredHeading;
            c.SkidIntensity *= Math.Max(0, 1 - 3 * dt);
        }

        c.Pos = new Vec2(c.Pos.X + Math.Cos(c.Heading) * c.Speed * dt, c.Pos.Y + Math.Sin(c.Heading) * c.Speed * dt);

        c.BoostGlow *= Math.Max(0, 1 - 2 * dt);
        if (accel && Math.Abs(c.Speed) > c.MaxSpeed * 0.85) c.BoostGlow = Math.Min(1, c.BoostGlow + dt * 2);
    }

    private void UpdateAi(SimCar c, double dt)
    {
        int n = _centerline.Count;

        // Stuck accounting + marshal rescue, evaluated first so nothing can pin a
        // bot for the whole race. We track lack of TRACK PROGRESS (not just low
        // speed): a bot boxed at the grid or scraped onto a wall can thrash back and
        // forth with speed yet advance nowhere — the old AI's core failure mode.
        // If a bot fails to advance for a sustained spell despite the reverse
        // maneuver below, a marshal places it back on the racing line facing forward
        // — a hard completion guarantee.
        // Monotonic track progress in node units (n per lap) — unlike DistanceAlongTrack
        // this never dips at the start/finish line, so it won't false-flag a lapping car.
        double progress = c.Lap * n + c.ProjIdx + c.ProjT;
        if (progress > c.ProgressMark + 0.5)
        {
            c.ProgressMark = progress;
            c.StuckTimer = 0;
        }
        else
        {
            c.StuckTimer += dt;
        }
        if (c.StuckTimer > 2.0)
        {
            // Nudge a few nodes PAST the snag, not back onto it, so a bot that keeps
            // re-wedging at the same corner still nets forward progress each rescue.
            int pi = ((c.ProjIdx + 5) % n + n) % n;
            var cp = _centerline[pi];
            var nb = _centerline[(pi + 1) % n];
            c.Pos = cp;
            c.Heading = Math.Atan2(nb.Y - cp.Y, nb.X - cp.X);
            c.Speed = c.MaxSpeed * 0.32;
            c.Steer = 0;
            c.StuckTimer = 0;
            return;
        }

        double speedFrac = Math.Clamp(Math.Abs(c.Speed) / c.MaxSpeed, 0, 1);

        // Aim a few nodes down the track — tight enough to follow the line through
        // corners instead of cutting the chord into the outside wall.
        int steerLook = (int)(3 + speedFrac * 6 + c.CorneringSkill * 3);
        int aimIdx = (c.LastCheckpoint + steerLook) % n;
        var target = _centerline[aimIdx];
        double desired = Math.Atan2(target.Y - c.Pos.Y, target.X - c.Pos.X);
        double diff = ShortAngleDiff(desired, c.Heading);

        // Predictive corner speed: measure how hard the track bends over a
        // speed-scaled window ahead and slow to a speed the car can actually hold
        // through it. Straights → near top speed; tight bends → a small fraction.
        int scan = (int)(9 + speedFrac * 15);
        double bend = UpcomingBend(c.LastCheckpoint, scan);
        double curviness = Math.Clamp(bend / 0.85, 0, 1);
        double cornerSpeed = c.MaxSpeed * (1.0 - 0.58 * curviness) * (0.92 + 0.14 * c.CorneringSkill);
        cornerSpeed = Math.Clamp(cornerSpeed, c.MaxSpeed * 0.36, c.MaxSpeed);

        const double deadband = 0.05;
        bool accel, brake = false, handbrake = false;
        bool left = diff < -deadband, right = diff > deadband;

        // Once the crawl has lasted a moment, back STRAIGHT out to make room, then
        // resume. If reversing still can't free the car the marshal rescue above
        // eventually fires; here we give it every chance to recover on its own first.
        if (c.StuckTimer > 0.7)
        {
            accel = false; brake = true;             // low speed + brake ⇒ reverse
            left = false; right = false;             // straight back-out; steer relaxes to centre
        }
        else if (Math.Abs(c.Speed) < c.MaxSpeed * 0.18)
        {
            accel = true;                            // slow but not wedged → power out toward aim
        }
        else if (c.Speed > cornerSpeed * 1.05) { accel = false; brake = true; }   // shed speed
        else if (c.Speed > cornerSpeed) { accel = false; }                 // coast to target
        else { accel = true; }                 // power on

        // Badly misaligned at speed (nose toward a wall) → brake to bleed it off.
        if (c.StuckTimer <= 0.7 && Math.Abs(c.Speed) >= c.MaxSpeed * 0.18 && Math.Abs(diff) > 1.25)
        {
            brake = true; accel = false;
        }

        ApplyControl(c, dt, accel, brake, left, right, handbrake);

        // Small stochastic imperfection so the field isn't robotic; less for skilled bots.
        if (Random.Shared.NextDouble() < 0.015 * (1.15 - c.CorneringSkill))
        {
            c.Steer += (Random.Shared.NextDouble() - 0.5) * 0.06;
        }
    }

    /// <summary>Cumulative absolute heading change (radians) over the next <paramref name="span"/>
    /// centerline segments — a cheap proxy for how sharp the upcoming track is.</summary>
    private double UpcomingBend(int startIdx, int span)
    {
        int n = _centerline.Count;
        double total = 0;
        for (int k = 0; k < span; k++)
        {
            var p0 = _centerline[(startIdx + k) % n];
            var p1 = _centerline[(startIdx + k + 1) % n];
            var p2 = _centerline[(startIdx + k + 2) % n];
            double h1 = Math.Atan2(p1.Y - p0.Y, p1.X - p0.X);
            double h2 = Math.Atan2(p2.Y - p1.Y, p2.X - p1.X);
            total += Math.Abs(ShortAngleDiff(h2, h1));
        }
        return total;
    }

    private void ResolveCarCollisions()
    {
        for (int i = 0; i < _cars.Count; i++)
        {
            for (int j = i + 1; j < _cars.Count; j++)
            {
                var a = _cars[i]; var b = _cars[j];
                var dx = b.Pos.X - a.Pos.X; var dy = b.Pos.Y - a.Pos.Y;
                var d = Math.Sqrt(dx * dx + dy * dy);
                var minD = CarRadius * 2;
                if (d < minD && d > 1e-3)
                {
                    var overlap = (minD - d) * 0.5;
                    var nx = dx / d; var ny = dy / d;
                    a.Pos = new Vec2(a.Pos.X - nx * overlap, a.Pos.Y - ny * overlap);
                    b.Pos = new Vec2(b.Pos.X + nx * overlap, b.Pos.Y + ny * overlap);
                    var aVel = ProjectVelocity(a, nx, ny);
                    var bVel = ProjectVelocity(b, nx, ny);
                    var rel = aVel - bVel;
                    var impulse = -rel * 0.6;
                    a.Speed += impulse * 0.4;
                    b.Speed -= impulse * 0.4;
                    a.Damage = Math.Min(1, a.Damage + 0.03);
                    b.Damage = Math.Min(1, b.Damage + 0.03);
                }
            }
        }
    }

    private static double ProjectVelocity(SimCar c, double nx, double ny)
    {
        var vx = Math.Cos(c.Heading) * c.Speed;
        var vy = Math.Sin(c.Heading) * c.Speed;
        return vx * nx + vy * ny;
    }

    private void Project(SimCar c)
    {
        var (idx, t, point, dist) = ClosestOnCenterline(c.Pos, c.LastCheckpoint);
        var a = _centerline[idx];
        var b = _centerline[(idx + 1) % _centerline.Count];
        var n = Normal(a, b);
        var dx = c.Pos.X - a.X; var dy = c.Pos.Y - a.Y;
        var side = dx * n.X + dy * n.Y;
        c.ProjIdx = idx; c.ProjT = t; c.ProjSide = side;
    }

    private void ResolveWallCollision(SimCar c)
    {
        double limit = _trackWidth * 0.5 - CarRadius;
        if (Math.Abs(c.ProjSide) <= limit) return;
        var sign = Math.Sign(c.ProjSide);
        var a = _centerline[c.ProjIdx];
        var b = _centerline[(c.ProjIdx + 1) % _centerline.Count];
        var n = Normal(a, b);
        var closest = new Vec2(a.X + (b.X - a.X) * c.ProjT, a.Y + (b.Y - a.Y) * c.ProjT);
        c.Pos = new Vec2(closest.X + n.X * sign * limit, closest.Y + n.Y * sign * limit);
        var tdx = b.X - a.X; var tdy = b.Y - a.Y;
        var tlen = Math.Sqrt(tdx * tdx + tdy * tdy);
        var tx = tdx / tlen; var ty = tdy / tlen;
        var nx = n.X * sign; var ny = n.Y * sign;
        var vx = Math.Cos(c.Heading) * c.Speed;
        var vy = Math.Sin(c.Heading) * c.Speed;
        var vInto = vx * nx + vy * ny;
        var vTangent = vx * tx + vy * ty;
        var vNormalNew = -Math.Abs(vInto) * 0.15;
        var vTangentNew = vTangent * 0.7;
        var vxNew = vTangentNew * tx + vNormalNew * nx;
        var vyNew = vTangentNew * ty + vNormalNew * ny;
        c.Speed = Math.Sqrt(vxNew * vxNew + vyNew * vyNew);
        c.Heading = Math.Atan2(vyNew, vxNew);
        c.Heading += sign * 0.2;
        c.SkidIntensity = 1.0;
        c.Damage = Math.Min(1, c.Damage + 0.08);
    }

    private void UpdateRaceProgress(SimCar c)
    {
        if (c.LastCheckpoint >= 0)
        {
            int prev = c.LastCheckpoint;
            double prevT = c.CheckpointT;
            int n = _centerline.Count;
            bool wrappedForward = prev > n - 3 && c.ProjIdx <= 1;
            bool withinSegmentForward = c.ProjIdx == prev && c.ProjT + 0.5 < prevT;
            if (wrappedForward || withinSegmentForward)
            {
                c.Lap++;
                // Fastest-lap timing: a lap just closed — measure it against the
                // race clock and keep the best. LapStartElapsed rebases to now so
                // the next lap times independently. This is the metric 1P scores on.
                var nowSec = (_wallClock.ElapsedMilliseconds - _startElapsedMs) / 1000.0;
                var lapTime = nowSec - c.LapStartElapsed;
                if (lapTime > 0 && (c.BestLapTime < 0 || lapTime < c.BestLapTime))
                {
                    c.BestLapTime = lapTime;
                }
                c.LapStartElapsed = nowSec;
                if (c.Lap > TotalLaps && c.FinishTime < 0)
                {
                    c.FinishTime = nowSec;
                }
            }
        }
        c.LastCheckpoint = c.ProjIdx;
        c.CheckpointT = c.ProjT;
        c.DistanceAlongTrack = c.Lap * 100000 + c.ProjIdx * 1000 + c.ProjT * 1000;
    }

    private void Rank()
    {
        var sorted = _cars.OrderByDescending(c => c.DistanceAlongTrack).ToList();
        for (int i = 0; i < sorted.Count; i++) sorted[i].Position = i + 1;
    }

    public bool AllFinishedOrStopped()
    {
        // Race is over when:
        //   * the 90 s safety cap has elapsed, OR
        //   * every car (player + AI) has crossed the line.
        // We deliberately check ALL cars (not just players) so a bot-only race
        // doesn't immediately finish via the vacuous-All-of-empty-set trap.
        var elapsed = _wallClock.ElapsedMilliseconds - _startElapsedMs;
        if (elapsed > StopAfterMs) return true;
        // Winner crossed + grace elapsed → the race is decided.
        if (_leaderFinishMs >= 0 && elapsed - _leaderFinishMs > FinishGraceMs) return true;
        return _cars.All(c => c.Lap > TotalLaps);
    }

    public PoRacerFinalResult BuildFinalResult(string code)
    {
        var elapsed = _wallClock.ElapsedMilliseconds - _startElapsedMs;
        var standings = _cars
            .OrderBy(c => c.Lap > TotalLaps ? c.Position : int.MaxValue)
            .ThenByDescending(c => c.DistanceAlongTrack)
            .Select((c, idx) => new PoRacerFinalEntry(
                idx + 1,
                c.Name,
                c.IsPlayer ? c.ConnectionId : "",
                !c.IsPlayer, // ai or guest by sign-up
                c.FinishTime,
                c.Lap > TotalLaps && c.FinishTime >= 0 && !double.IsInfinity(c.FinishTime),
                c.BestLapTime))
            .ToList();
        return new PoRacerFinalResult(code, standings, DateTimeOffset.UtcNow);
    }

    public PoRacerRaceSnapshot Snapshot(string code, int countdownMs)
    {
        var cars = _cars.Select(c => new PoRacerCarState
        {
            Id = c.Id,
            Name = c.Name,
            Color = c.Color,
            ColorDark = c.ColorDark,
            X = c.Pos.X,
            Y = c.Pos.Y,
            Heading = c.Heading,
            Speed = c.Speed,
            Lap = c.Lap,
            FinishTime = c.FinishTime,
            BestLapSeconds = c.BestLapTime,
            IsPlayer = c.IsPlayer,
            Finished = c.Lap > TotalLaps,
            Position = c.Position,
            SkidIntensity = c.SkidIntensity,
            BoostGlow = c.BoostGlow,
            Damage = c.Damage,
        }).ToList();
        var elapsed = (_wallClock.ElapsedMilliseconds - _startElapsedMs) / 1000.0;
        return new PoRacerRaceSnapshot
        {
            GameCode = code,
            ServerTimeMs = _wallClock.ElapsedMilliseconds,
            Cars = cars,
            ElapsedRaceTime = elapsed,
            CountdownMs = countdownMs,
            Started = countdownMs == 0,
            Finished = AllFinishedOrStopped(),
        };
    }

    // ── Math helpers (mirror the client's Catmull-Rom track) ─────────────

    private static List<Vec2> ResampleClosedSpline(List<Vec2> pts, int subdivisions)
    {
        var result = new List<Vec2>(pts.Count * subdivisions);
        int n = pts.Count;
        for (int i = 0; i < n; i++)
        {
            var p0 = pts[(i - 1 + n) % n];
            var p1 = pts[i];
            var p2 = pts[(i + 1) % n];
            var p3 = pts[(i + 2) % n];
            for (int s = 0; s < subdivisions; s++)
            {
                double t = s / (double)subdivisions;
                result.Add(CatmullRom(p0, p1, p2, p3, t));
            }
        }
        return result;
    }

    private static Vec2 CatmullRom(Vec2 p0, Vec2 p1, Vec2 p2, Vec2 p3, double t)
    {
        double t2 = t * t, t3 = t2 * t;
        double x = 0.5 * ((2 * p1.X) +
                          (-p0.X + p2.X) * t +
                          (2 * p0.X - 5 * p1.X + 4 * p2.X - p3.X) * t2 +
                          (-p0.X + 3 * p1.X - 3 * p2.X + p3.X) * t3);
        double y = 0.5 * ((2 * p1.Y) +
                          (-p0.Y + p2.Y) * t +
                          (2 * p0.Y - 5 * p1.Y + 4 * p2.Y - p3.Y) * t2 +
                          (-p0.Y + 3 * p1.Y - 3 * p2.Y + p3.Y) * t3);
        return new Vec2(x, y);
    }

    private static Vec2 Normal(Vec2 a, Vec2 b)
    {
        var dx = b.X - a.X; var dy = b.Y - a.Y;
        var len = Math.Sqrt(dx * dx + dy * dy);
        if (len < 1e-6) return new Vec2(0, 0);
        return new Vec2(-dy / len, dx / len);
    }

    private (int idx, double t, Vec2 point, double dist) ClosestOnCenterline(Vec2 p, int hint = -1)
    {
        int n = _centerline.Count;
        double bestSq = double.MaxValue;
        int bestIdx = 0; double bestT = 0; Vec2 bestPt = default;
        if (hint >= 0 && n > 0)
        {
            const int window = 6;
            for (int k = -window; k <= window; k++)
            {
                int i = ((hint + k) % n + n) % n;
                var a = _centerline[i];
                var b = _centerline[(i + 1) % n];
                var (pt, t) = ClosestPointOnSegment(p, a, b);
                double ddx = p.X - pt.X, ddy = p.Y - pt.Y;
                double sq = ddx * ddx + ddy * ddy;
                if (sq < bestSq) { bestSq = sq; bestIdx = i; bestT = t; bestPt = pt; }
            }
            return (bestIdx, bestT, bestPt, Math.Sqrt(bestSq));
        }
        for (int i = 0; i < n; i++)
        {
            var a = _centerline[i];
            var b = _centerline[(i + 1) % n];
            var (pt, t) = ClosestPointOnSegment(p, a, b);
            double ddx = p.X - pt.X, ddy = p.Y - pt.Y;
            double sq = ddx * ddx + ddy * ddy;
            if (sq < bestSq) { bestSq = sq; bestIdx = i; bestT = t; bestPt = pt; }
        }
        return (bestIdx, bestT, bestPt, Math.Sqrt(bestSq));
    }

    private static (Vec2 pt, double t) ClosestPointOnSegment(Vec2 p, Vec2 a, Vec2 b)
    {
        var abx = b.X - a.X; var aby = b.Y - a.Y;
        var len2 = abx * abx + aby * aby;
        if (len2 < 1e-9) return (a, 0);
        var t = ((p.X - a.X) * abx + (p.Y - a.Y) * aby) / len2;
        t = Math.Clamp(t, 0, 1);
        return (new Vec2(a.X + abx * t, a.Y + aby * t), t);
    }

    private static double ShortAngleDiff(double a, double b)
    {
        var diff = (a - b) % (2 * Math.PI);
        if (diff > Math.PI) diff -= 2 * Math.PI;
        if (diff < -Math.PI) diff += 2 * Math.PI;
        return diff;
    }

    private static string Darken(string hex)
    {
        if (hex.StartsWith("#") && hex.Length == 7)
        {
            int r = Convert.ToInt32(hex.Substring(1, 2), 16);
            int g = Convert.ToInt32(hex.Substring(3, 2), 16);
            int b = Convert.ToInt32(hex.Substring(5, 2), 16);
            r = (int)(r * 0.35); g = (int)(g * 0.35); b = (int)(b * 0.35);
            return $"#{r:X2}{g:X2}{b:X2}";
        }
        return "#222";
    }

    private readonly struct Vec2
    {
        public readonly double X, Y;
        public Vec2(double x, double y) { X = x; Y = y; }
    }

    private sealed class SimCar
    {
        public int Id;
        public string ConnectionId = "";
        public string Name = "";
        public string Color = "#ffffff";
        public string ColorDark = "#222";
        public Vec2 Pos;
        public double Heading;
        public double Speed;
        public double Steer;
        public bool IsPlayer;
        public double CorneringSkill;
        public double MaxSpeed;
        public double Acceleration;
        public double Handling;
        public int Lap = 1;
        public int LastCheckpoint = -1;
        public double CheckpointT;
        public double DistanceAlongTrack;
        public double FinishTime = -1;
        public double BestLapTime = -1;   // fastest single lap (s); -1 until first lap done
        public double LapStartElapsed = 0; // race-clock seconds when the current lap began
        public int Position;
        public int ProjIdx;
        public double ProjT;
        public double ProjSide;
        public double SkidIntensity;
        public double BoostGlow;
        public double Damage;
        public double StuckTimer;   // seconds without track progress — drives the AI unstick maneuver
        public double ProgressMark; // last DistanceAlongTrack the car meaningfully advanced past
    }
}
