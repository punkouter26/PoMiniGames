using PoMiniGames.Shared.Games;

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
        // Classic stadium oval — two long straights joined by tight 180° banked hairpins.
        // Distinct shape: symmetric pill/racetrack oval.
        var rawKnots = new (double x, double y)[]
        {
            (0,     0),
            (400,   0),
            (800,   0),
            (1200,  0),
            (1500,  80),
            (1650,  280),
            (1650,  500),
            (1500,  700),
            (1200,  780),
            (800,   780),
            (400,   780),
            (0,     780),
            (-300,  700),
            (-450,  500),
            (-450,  280),
            (-300,  80),
        };
        const double trackWidth = 230.0;
        var centerline = ResampleClosedSpline(rawKnots.Select(p => new Vec2(p.x, p.y)).ToList(), 10);
        var walls = GenerateWalls(centerline, trackWidth);

        var surfaces = new List<PoRacerSurfaceZoneDefinition>
        {
            new() { Name = "Main Tarmac", SurfaceType = SurfaceKind.Asphalt, Center = new Vec2(600, 390), Radius = 2000.0, GripMultiplier = 1.0 }
        };

        return new PoRacerTrackData
        {
            Id = "circuit",
            DisplayName = PoRacerCatalog.GetTrack("circuit").Name,
            Description = PoRacerCatalog.GetTrack("circuit").Description,
            TrackWidth = trackWidth,
            Centerline = centerline,
            Walls = walls,
            BoostPads = [],
            SurfaceZones = surfaces,
            EnvironmentTheme = "circuit"
        };
    }

    private static PoRacerTrackData BuildNeonSkyline()
    {
        // Figure-8 crossover layout — two loops crossing in the middle.
        // Distinct shape: one large outer loop + one tight inner loop sharing a central crossing.
        var rawKnots = new (double x, double y)[]
        {
            // Start on the bridge / crossing point
            (800,   400),
            // Top loop — wide, fast
            (1000,  150),
            (1400,  -50),
            (1800,  100),
            (1950,  400),
            (1800,  700),
            (1400,  850),
            (1000,  700),
            // Back through the crossing (inverted direction)
            (800,   400),
            // Bottom loop — tight, technical
            (600,   600),
            (300,   800),
            (50,    650),
            (-50,   400),
            (50,    150),
            (300,   0),
            (600,   150),
        };
        const double trackWidth = 210.0;
        var centerline = ResampleClosedSpline(rawKnots.Select(p => new Vec2(p.x, p.y)).ToList(), 12);
        var walls = GenerateWalls(centerline, trackWidth);

        var surfaces = new List<PoRacerSurfaceZoneDefinition>
        {
            new() { Name = "Cyber Tarmac", SurfaceType = SurfaceKind.Asphalt, Center = new Vec2(900, 400), Radius = 2500.0, GripMultiplier = 1.0 }
        };

        return new PoRacerTrackData
        {
            Id = "neonskyline",
            DisplayName = PoRacerCatalog.GetTrack("neonskyline").Name,
            Description = PoRacerCatalog.GetTrack("neonskyline").Description,
            TrackWidth = trackWidth,
            Centerline = centerline,
            Walls = walls,
            BoostPads = [],
            SurfaceZones = surfaces,
            EnvironmentTheme = "neonskyline"
        };
    }

    private static PoRacerTrackData BuildDesertDustway()
    {
        // L-shaped circuit — one long back straight, tight 90° hairpin corners, like a real rally stage.
        // Distinct shape: L / boot shape with sharp chicane section.
        var rawKnots = new (double x, double y)[]
        {
            // Start / finish on the long front straight
            (0,     0),
            (700,   0),
            (1400,  0),
            // Fast right-hand sweeper into the back section
            (1750,  200),
            (1850,  500),
            // Long back straight going left
            (1750,  800),
            (1200,  950),
            (600,   950),
            // Tight left hairpin at the far end
            (100,   950),
            (-150,  800),
            // The chicane: two quick S-bends
            (-300,  600),
            (-100,  400),
            (-300,  200),
            // Returns to the pit straight
            (-200,  50),
        };
        const double trackWidth = 255.0;
        var centerline = ResampleClosedSpline(rawKnots.Select(p => new Vec2(p.x, p.y)).ToList(), 14);
        var walls = GenerateWalls(centerline, trackWidth);

        // Sand zones in the outer hairpin run-off areas
        var surfaces = new List<PoRacerSurfaceZoneDefinition>
        {
            new() { Name = "Dune Run-off East", SurfaceType = SurfaceKind.Sand, Center = new Vec2(1850, 500), Radius = 260.0, GripMultiplier = 0.65 },
            new() { Name = "Dune Run-off West", SurfaceType = SurfaceKind.Sand, Center = new Vec2(-150, 800), Radius = 240.0, GripMultiplier = 0.65 }
        };

        return new PoRacerTrackData
        {
            Id = "desertdustway",
            DisplayName = PoRacerCatalog.GetTrack("desertdustway").Name,
            Description = PoRacerCatalog.GetTrack("desertdustway").Description,
            TrackWidth = trackWidth,
            Centerline = centerline,
            Walls = walls,
            BoostPads = [],
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
