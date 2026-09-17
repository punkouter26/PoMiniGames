namespace PoMiniGames.Features.PoRacer;

public static class PoRacerTrackRegistry
{
    private static readonly Dictionary<string, PoRacerTrackData> _tracks = new(StringComparer.OrdinalIgnoreCase);

    static PoRacerTrackRegistry()
    {
        Register(BuildCircuit());
        Register(BuildNeonSkyline());
        Register(BuildDesertDustway());
    }

    private static void Register(PoRacerTrackData track) => _tracks[track.Id] = track;

    public static IReadOnlyCollection<PoRacerTrackData> AllTracks => _tracks.Values;

    public static PoRacerTrackData GetTrack(string? trackId)
    {
        if (!string.IsNullOrWhiteSpace(trackId) && _tracks.TryGetValue(trackId, out var track))
        {
            return track;
        }
        return _tracks["circuit"];
    }

    private static PoRacerTrackData BuildCircuit()
    {
        var rawKnots = new (double x, double y)[]
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
        const double trackWidth = 240.0;
        var centerline = ResampleClosedSpline(rawKnots.Select(p => new Vec2(p.x, p.y)).ToList(), 12);
        var walls = GenerateWalls(centerline, trackWidth);

        var boostPads = new List<PoRacerBoostPadDefinition>
        {
            new() { Position = centerline[centerline.Count / 6], DirectionAngle = 0.0, Radius = 45.0 },
            new() { Position = centerline[centerline.Count / 2], DirectionAngle = 0.0, Radius = 45.0 }
        };

        var surfaces = new List<PoRacerSurfaceZoneDefinition>
        {
            new() { Name = "Main Tarmac", SurfaceType = SurfaceKind.Asphalt, Center = new Vec2(900, 300), Radius = 2000.0, GripMultiplier = 1.0 }
        };

        return new PoRacerTrackData
        {
            Id = "circuit",
            DisplayName = "Grand Prix Circuit",
            Description = "Classic asphalt circuit with high grip, sweeping corners, and technical hairpins.",
            TrackWidth = trackWidth,
            Centerline = centerline,
            Walls = walls,
            BoostPads = boostPads,
            SurfaceZones = surfaces,
            EnvironmentTheme = "circuit"
        };
    }

    private static PoRacerTrackData BuildNeonSkyline()
    {
        // High-speed cyber city layout with rectangular chicanes and high-velocity overpass
        var rawKnots = new (double x, double y)[]
        {
            (0, 0),
            (800, 0),
            (1500, -100),
            (1900, 300),
            (1900, 900),
            (1300, 1100),
            (600, 1100),
            (100, 800),
            (-300, 800),
            (-500, 400),
            (-200, 100)
        };
        const double trackWidth = 220.0;
        var centerline = ResampleClosedSpline(rawKnots.Select(p => new Vec2(p.x, p.y)).ToList(), 14);
        var walls = GenerateWalls(centerline, trackWidth);

        var boostPads = new List<PoRacerBoostPadDefinition>
        {
            new() { Position = centerline[15], DirectionAngle = 0.0, Radius = 45.0 },
            new() { Position = centerline[centerline.Count / 2], DirectionAngle = 0.0, Radius = 45.0 },
            new() { Position = centerline[(int)(centerline.Count * 0.8)], DirectionAngle = 0.0, Radius = 45.0 }
        };

        var surfaces = new List<PoRacerSurfaceZoneDefinition>
        {
            new() { Name = "Cyber Tarmac", SurfaceType = SurfaceKind.Asphalt, Center = new Vec2(700, 500), Radius = 2500.0, GripMultiplier = 1.0 }
        };

        return new PoRacerTrackData
        {
            Id = "neonskyline",
            DisplayName = "Neon Skyline",
            Description = "Futuristic midnight city track lined with glowing cyber barriers and multiple turbo pads.",
            TrackWidth = trackWidth,
            Centerline = centerline,
            Walls = walls,
            BoostPads = boostPads,
            SurfaceZones = surfaces,
            EnvironmentTheme = "neonskyline"
        };
    }

    private static PoRacerTrackData BuildDesertDustway()
    {
        // Wide flowing rally track with large loose sand drift zones
        var rawKnots = new (double x, double y)[]
        {
            (0, 0),
            (500, -250),
            (1100, -400),
            (1600, -200),
            (1800, 300),
            (1500, 750),
            (1000, 950),
            (400, 750),
            (-200, 600),
            (-450, 250),
            (-250, -100)
        };
        const double trackWidth = 260.0;
        var centerline = ResampleClosedSpline(rawKnots.Select(p => new Vec2(p.x, p.y)).ToList(), 14);
        var walls = GenerateWalls(centerline, trackWidth);

        var boostPads = new List<PoRacerBoostPadDefinition>
        {
            new() { Position = centerline[20], DirectionAngle = 0.0, Radius = 50.0 },
            new() { Position = centerline[(int)(centerline.Count * 0.65)], DirectionAngle = 0.0, Radius = 50.0 }
        };

        // Sand off-road zones along hairpins
        var surfaces = new List<PoRacerSurfaceZoneDefinition>
        {
            new() { Name = "Dune Drift North", SurfaceType = SurfaceKind.Sand, Center = new Vec2(1500, 750), Radius = 300.0, GripMultiplier = 0.68 },
            new() { Name = "Dune Drift South", SurfaceType = SurfaceKind.Sand, Center = new Vec2(1100, -400), Radius = 280.0, GripMultiplier = 0.68 }
        };

        return new PoRacerTrackData
        {
            Id = "desertdustway",
            DisplayName = "Desert Dustway",
            Description = "Sun-scorched desert rally course with loose sand corners, reduced grip, and wide drift slides.",
            TrackWidth = trackWidth,
            Centerline = centerline,
            Walls = walls,
            BoostPads = boostPads,
            SurfaceZones = surfaces,
            EnvironmentTheme = "desertdustway"
        };
    }

    private static List<Vec2> ResampleClosedSpline(IReadOnlyList<Vec2> knots, int stepsPerSegment)
    {
        var result = new List<Vec2>(knots.Count * stepsPerSegment);
        int n = knots.Count;
        for (int i = 0; i < n; i++)
        {
            var p0 = knots[(i - 1 + n) % n];
            var p1 = knots[i];
            var p2 = knots[(i + 1) % n];
            var p3 = knots[(i + 2) % n];
            for (int s = 0; s < stepsPerSegment; s++)
            {
                double t = s / (double)stepsPerSegment;
                double t2 = t * t, t3 = t2 * t;
                double x = 0.5 * ((2 * p1.X) + (-p0.X + p2.X) * t + (2 * p0.X - 5 * p1.X + 4 * p2.X - p3.X) * t2 + (-p0.X + 3 * p1.X - 3 * p2.X + p3.X) * t3);
                double y = 0.5 * ((2 * p1.Y) + (-p0.Y + p2.Y) * t + (2 * p0.Y - 5 * p1.Y + 4 * p2.Y - p3.Y) * t2 + (-p0.Y + 3 * p1.Y - 3 * p2.Y + p3.Y) * t3);
                result.Add(new Vec2(x, y));
            }
        }
        return result;
    }

    private static List<(Vec2 a, Vec2 b)> GenerateWalls(IReadOnlyList<Vec2> centerline, double trackWidth)
    {
        var walls = new List<(Vec2 a, Vec2 b)>(centerline.Count * 2);
        int n = centerline.Count;
        double hw = trackWidth * 0.5;

        for (int i = 0; i < n; i++)
        {
            var a = centerline[i];
            var b = centerline[(i + 1) % n];
            var norm = ComputeNormal(a, b);

            var leftA = new Vec2(a.X - norm.X * hw, a.Y - norm.Y * hw);
            var leftB = new Vec2(b.X - norm.X * hw, b.Y - norm.Y * hw);
            var rightA = new Vec2(a.X + norm.X * hw, a.Y + norm.Y * hw);
            var rightB = new Vec2(b.X + norm.X * hw, b.Y + norm.Y * hw);

            walls.Add((leftA, leftB));
            walls.Add((rightA, rightB));
        }
        return walls;
    }

    public static Vec2 ComputeNormal(Vec2 a, Vec2 b)
    {
        double dx = b.X - a.X, dy = b.Y - a.Y;
        double len = Math.Sqrt(dx * dx + dy * dy);
        if (len < 1e-9) return new Vec2(0, 1);
        return new Vec2(-dy / len, dx / len);
    }
}
