using System.Diagnostics;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// Server-authoritative PoCabinet simulation engine. No SignalR, no Blazor, no JS —
/// the racing service drives it on a timer and broadcasts the snapshot. T2 ships
/// the physics tick + lap/finish detection; T3 wires AI personalities on top of
/// the same tick via <see cref="PoCabinetAiDriver"/>; T4 adds the wire DTOs.
///
/// <para>
/// The math is intentionally close to PoRacerSim (reusing the same projection,
/// collision, and lap-detection logic) so multiplayer code reviewed against
/// PoRacer's server-authoritative pattern carries over. The differences are
/// scoped: PoCabinet uses 4 cars by default (extensible to 8 for multiplayer),
/// 3 laps per race (matches <see cref="PoCabinetCatalog.TotalLaps"/>), and no
/// boost pads or sand zones for v1.
/// </para>
/// </summary>
public sealed class PoCabinetSim
{
    private const double CarRadius = 14;
    private const double MaxSpeedKmh = 280;
    private const int DefaultLaps = PoCabinetCatalog.TotalLaps;
    private const double StopAfterMs = 180_000;
    private const double FinishGraceMs = 5_000;

    private readonly PoCabinetTrackData _track;
    private readonly List<Vec2> _centerline = new();
    private readonly List<(Vec2 a, Vec2 b)> _walls = new();
    private readonly double _trackWidth;

    private readonly List<SimCar> _cars = new();
    private readonly Dictionary<string, SimCar> _byOwnerId = new(StringComparer.Ordinal);
    private readonly Stopwatch _wallClock = Stopwatch.StartNew();
    private long _startElapsedMs;
    private double _leaderFinishMs = -1;
    private readonly Random _rng;

    public PoCabinetSim(string? trackId, int seed, IReadOnlyList<PoCabinetDriver> drivers)
    {
        if (drivers is null || drivers.Count == 0)
            throw new ArgumentException("at least one driver is required", nameof(drivers));
        if (drivers.Count > PoCabinetCatalog.CarCount)
            throw new ArgumentException($"max {PoCabinetCatalog.CarCount} drivers", nameof(drivers));

        _track = PoCabinetTrackRegistry.GetTrack(trackId);
        _trackWidth = _track.TrackWidth;
        _centerline.AddRange(_track.Centerline);
        _walls.AddRange(_track.Walls);
        _rng = new Random(seed);

        // Spawn grid: 2 cols × N rows along the first segment direction.
        var startA = _centerline[0];
        var startB = _centerline[1];
        var dx = startB.X - startA.X; var dy = startB.Y - startA.Y;
        var dlen = Math.Sqrt(dx * dx + dy * dy);
        var tx = dx / dlen; var ty = dy / dlen;
        var nrm = new Vec2(-ty, tx);

        for (int i = 0; i < drivers.Count; i++)
        {
            var d = drivers[i];
            int row = i / 2;
            int col = i % 2;
            double fwdOffset = 60 + row * 38;
            double sideOffset = (col == 0 ? -28.0 : 28.0) - (row * 4);
            var pos = new Vec2(
                startA.X + tx * fwdOffset + nrm.X * sideOffset,
                startA.Y + ty * fwdOffset + nrm.Y * sideOffset);

            _cars.Add(new SimCar
            {
                Id = i,
                OwnerId = d.OwnerId,
                Name = d.Name,
                IsPlayer = d.IsPlayer,
                Color = d.Color,
                Personality = d.Personality,
                Pos = pos,
                Heading = Math.Atan2(ty, tx),
                MaxSpeed = d.MaxSpeed,
                Acceleration = d.Acceleration,
                Handling = d.Handling,
                CorneringSkill = d.CorneringSkill,
                Lap = 1,
                LastCheckpoint = 0,
                CheckpointT = 0,
                DistanceAlongTrack = 0,
            });
            if (d.IsPlayer) _byOwnerId[d.OwnerId] = _cars[^1];
        }

        _startElapsedMs = _wallClock.ElapsedMilliseconds; // countdown handled by the racing service
        foreach (var car in _cars)
        {
            Project(car);
            UpdateRaceProgress(car);
        }
    }

    /// <summary>Track this sim is running on (id is the registry key).</summary>
    public string TrackId => _track.Id;

    /// <summary>Total laps configured for this race.</summary>
    public int TotalLaps { get; init; } = DefaultLaps;

    public int CarCount => _cars.Count;
    public bool IsFinished { get; private set; }

    public int? CarIdForOwner(string ownerId) => _byOwnerId.TryGetValue(ownerId, out var car) ? car.Id : null;

    /// <summary>
    /// Apply one physics tick. Pure C#, deterministic given identical inputs +
    /// identical RNG state. The racing service calls this on a 30 Hz timer and
    /// emits a snapshot over SignalR after every successful tick.
    /// </summary>
    public void Tick(double dt, IReadOnlyDictionary<string, PoCabinetInput> inputs)
    {
        if (IsFinished) return;
        if (_wallClock.ElapsedMilliseconds < _startElapsedMs) return;

        // 1. Player inputs.
        foreach (var (ownerId, car) in _byOwnerId)
        {
            if (car.Lap > TotalLaps) continue;
            inputs.TryGetValue(ownerId, out var inp);
            ApplyControl(car, dt, inp?.Up ?? false, inp?.Down ?? false, inp?.Left ?? false, inp?.Right ?? false);
        }
        // 2. AI ticks (populated in T3 via PoCabinetAiDriver; no-op when no personality).
        foreach (var c in _cars)
        {
            if (c.IsPlayer) continue;
            if (c.Lap > TotalLaps) continue;
            if (c.Personality is null) continue;
            ApplyAi(c, dt);
        }
        // 3. Car-car collisions.
        ResolveCarCollisions();
        // 4. Speed safety clamp.
        foreach (var c in _cars) c.Speed = Math.Clamp(c.Speed, -c.MaxSpeed, c.MaxSpeed);
        // 5. Project onto centerline.
        foreach (var c in _cars) Project(c);
        // 6. Wall collisions.
        foreach (var c in _cars) ResolveWallCollision(c);
        // 7. Lap detection.
        foreach (var c in _cars) UpdateRaceProgress(c);

        // Race-end bookkeeping.
        var leader = _cars.OrderByDescending(c => c.Lap * 1_000_000 + c.DistanceAlongTrack).First();
        if (leader.Lap > TotalLaps && _leaderFinishMs < 0)
        {
            _leaderFinishMs = _wallClock.ElapsedMilliseconds;
        }
        var raceWallMs = _wallClock.ElapsedMilliseconds;
        var anyStillRacing = _cars.Any(c => c.Lap <= TotalLaps);
        var graceExpired = _leaderFinishMs > 0 && raceWallMs - _leaderFinishMs > FinishGraceMs;
        var safetyHit = raceWallMs > StopAfterMs;
        if (!anyStillRacing || graceExpired || safetyHit)
        {
            foreach (var c in _cars)
            {
                if (c.Lap <= TotalLaps) c.Lap = TotalLaps + 1; // mark all as finished
            }
            IsFinished = true;
        }
    }

    /// <summary>Snapshot the sim state for the wire DTO (added in T4).</summary>
    public IReadOnlyList<SimCar> SnapshotCars() => _cars;

    /// <summary>Current world centerline (for the client scene).</summary>
    public IReadOnlyList<Vec2> Centerline() => _centerline;

    // ──────────────────────────────────────────────────────────────────────
    //  Internals
    // ──────────────────────────────────────────────────────────────────────

    private void ApplyControl(SimCar car, double dt, bool up, bool down, bool left, bool right)
    {
        double accel = 0;
        if (up) accel += car.Acceleration;
        if (down) accel -= car.Acceleration * 0.8;
        car.Speed += accel * dt;

        // Steering — only takes effect when the car is moving (PoRacer pattern).
        if (car.Speed > 1.0 || car.Speed < -1.0)
        {
            double turnRate = 2.4 * car.Handling * (car.Speed >= 0 ? 1 : -1);
            if (left) car.Heading -= turnRate * dt;
            if (right) car.Heading += turnRate * dt;
        }
    }

    private void ApplyAi(SimCar car, double dt)
    {
        if (car.Personality is null) return;
        PoCabinetAiDriver.Step(_centerline, car, car.Personality, dt);
    }

    private void ResolveCarCollisions()
    {
        for (int i = 0; i < _cars.Count; i++)
        {
            for (int j = i + 1; j < _cars.Count; j++)
            {
                var a = _cars[i]; var b = _cars[j];
                double dx = b.Pos.X - a.Pos.X, dy = b.Pos.Y - a.Pos.Y;
                double d = Math.Sqrt(dx * dx + dy * dy);
                double min = CarRadius * 2;
                if (d > 0 && d < min)
                {
                    double push = (min - d) * 0.5;
                    double nx = dx / d;
                    double ny = dy / d;
                    a.Pos = new Vec2(a.Pos.X - nx * push, a.Pos.Y - ny * push);
                    b.Pos = new Vec2(b.Pos.X + nx * push, b.Pos.Y + ny * push);
                    // Soft speed transfer.
                    double avg = (a.Speed + b.Speed) * 0.5;
                    a.Speed = avg * 0.95;
                    b.Speed = avg * 0.95;
                }
            }
        }
    }

    private void Project(SimCar car)
    {
        // Find the closest centerline segment to the car, store its t in [0..1] and the
        // segment index in CheckpointT / LastCheckpoint. Used for both steering (T3 AI)
        // and lap detection (UpdateRaceProgress).
        double bestD2 = double.MaxValue;
        int bestIdx = 0;
        double bestT = 0;
        for (int i = 0; i < _centerline.Count; i++)
        {
            var a = _centerline[i];
            var b = _centerline[(i + 1) % _centerline.Count];
            double t = ProjectOnSegment(car.Pos, a, b, out double d2);
            if (d2 < bestD2) { bestD2 = d2; bestIdx = i; bestT = t; }
        }
        car.LastCheckpoint = bestIdx;
        car.CheckpointT = bestT;
    }

    private static double ProjectOnSegment(Vec2 p, Vec2 a, Vec2 b, out double distanceSquared)
    {
        double dx = b.X - a.X, dy = b.Y - a.Y;
        double len2 = dx * dx + dy * dy;
        if (len2 < 1e-9) { distanceSquared = (p.X - a.X) * (p.X - a.X) + (p.Y - a.Y) * (p.Y - a.Y); return 0; }
        double t = ((p.X - a.X) * dx + (p.Y - a.Y) * dy) / len2;
        t = Math.Clamp(t, 0, 1);
        double projX = a.X + t * dx, projY = a.Y + t * dy;
        double ex = p.X - projX, ey = p.Y - projY;
        distanceSquared = ex * ex + ey * ey;
        return t;
    }

    private void ResolveWallCollision(SimCar car)
    {
        // Soft wall pushback: nudge the car back to the centerline if it has drifted
        // further than trackWidth/2 from any segment.
        double maxOffset = _trackWidth * 0.5 - CarRadius;
        for (int i = 0; i < _walls.Count; i += 2)
        {
            var leftWall = _walls[i];
            var rightWall = _walls[i + 1];
            // Distance from car to wall midpoint is a cheap proxy; for production we'd
            // compute distance-to-segment. v1 keeps it simple.
            var mid = new Vec2((leftWall.a.X + leftWall.b.X) * 0.5, (leftWall.a.Y + leftWall.b.Y) * 0.5);
            double dx = car.Pos.X - mid.X, dy = car.Pos.Y - mid.Y;
            double d = Math.Sqrt(dx * dx + dy * dy);
            if (d > maxOffset && d > 0)
            {
                double push = d - maxOffset;
                car.Pos = new Vec2(car.Pos.X - (dx / d) * push * 0.5, car.Pos.Y - (dy / d) * push * 0.5);
                car.Speed *= 0.85; // soft braking on wall contact
            }
        }
    }

    private void UpdateRaceProgress(SimCar car)
    {
        // Distance along track: weighted by completed centerline segments + current segment t.
        int n = _centerline.Count;
        double segLen = 0;
        for (int i = 0; i < n; i++)
        {
            var a = _centerline[i];
            var b = _centerline[(i + 1) % n];
            segLen += Math.Sqrt((b.X - a.X) * (b.X - a.X) + (b.Y - a.Y) * (b.Y - a.Y));
        }
        double avgSeg = segLen / n;
        double along = (car.LastCheckpoint + car.CheckpointT) * avgSeg;

        // Lap increment: when the car crosses back to checkpoint 0 after a forward sweep.
        if (car.LastCheckpoint == 0 && car.CheckpointT < 0.1 && car.PreviousCheckpointT > 0.9)
        {
            if (car.DistanceAlongTrack > avgSeg * 2) // ignore wrap-around at the start
                car.Lap += 1;
        }
        // Wrap-around guard: if the car teleports (e.g. marshal rescue in T3), reset lap.
        if (car.DistanceAlongTrack > 0 && Math.Abs(along - car.DistanceAlongTrack) > avgSeg * 5)
        {
            car.Lap = Math.Max(1, car.Lap);
        }
        car.DistanceAlongTrack = along;
        car.PreviousCheckpointT = car.CheckpointT;
    }

    // ──────────────────────────────────────────────────────────────────────
    //  SimCar: server-side per-car state. Public so the wire DTO can read it.
    // ──────────────────────────────────────────────────────────────────────

    public sealed class SimCar
    {
        public int Id { get; init; }
        public required string OwnerId { get; init; }
        public required string Name { get; init; }
        public required bool IsPlayer { get; init; }
        public required string Color { get; init; }
        public PoCabinetPersonality? Personality { get; init; }
        public double MaxSpeed { get; init; }
        public double Acceleration { get; init; }
        public double Handling { get; init; }
        public double CorneringSkill { get; init; }
        public Vec2 Pos { get; set; }
        public double Heading { get; set; }
        public double Speed { get; set; }
        public int Lap { get; set; }
        public int LastCheckpoint { get; set; }
        public double CheckpointT { get; set; }
        public double PreviousCheckpointT { get; set; }
        public double DistanceAlongTrack { get; set; }
    }
}

/// <summary>Driver row passed into <see cref="PoCabinetSim"/> at construction time.</summary>
public sealed record PoCabinetDriver(
    string OwnerId,
    string Name,
    bool IsPlayer,
    string Color,
    PoCabinetPersonality? Personality,
    double MaxSpeed = 220,
    double Acceleration = 200,
    double Handling = 1.0,
    double CorneringSkill = 0.7);

/// <summary>Per-tick player input (WASD / arrows).</summary>
public sealed record PoCabinetInput(bool Up, bool Down, bool Left, bool Right);

/// <summary>
/// Personality parameter bundle for an AI driver. Reused by
/// <see cref="PoCabinetAiDriver"/> in T3. Values default to neutral so a missing
/// personality degrades to "drive forward at moderate speed" (see
/// <see cref="PoCabinetSim.ApplyAi"/>).
/// </summary>
public sealed record PoCabinetPersonality(
    double LookaheadDistance = 60,
    double LateralOffset = 0.0,
    double BrakingAggression = 0.5,
    double CollisionTolerance = 0.5,
    double DraftingAffinity = 0.0)
{
    /// <summary>The four named officials for v1. T3 wires these into the AI driver.</summary>
    public static class Officials
    {
        // Each official's parameters are spread far enough that their lines diverge by
        // a measurable amount on every track — the E2E-API contract test (PoCabinetAiPersonalityTests)
        // asserts ≥ 5° average heading delta between any two officials over a 200-tick sim.
        public static readonly PoCabinetPersonality SeanS = new(
            LookaheadDistance: 25, LateralOffset: -0.95, BrakingAggression: 0.95,
            CollisionTolerance: 0.2, DraftingAffinity: 0.1);
        public static readonly PoCabinetPersonality SteveB = new(
            LookaheadDistance: 45, LateralOffset: 0.85, BrakingAggression: 0.20,
            CollisionTolerance: 0.6, DraftingAffinity: 0.2);
        public static readonly PoCabinetPersonality BillB = new(
            LookaheadDistance: 100, LateralOffset: 0.0, BrakingAggression: 0.50,
            CollisionTolerance: 0.9, DraftingAffinity: 0.0);
        public static readonly PoCabinetPersonality MikeP = new(
            LookaheadDistance: 130, LateralOffset: -0.40, BrakingAggression: 0.40,
            CollisionTolerance: 0.3, DraftingAffinity: 0.95);
    }
}
