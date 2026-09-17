using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// Static registry of the three themed PoCabinet tracks. The centerline math
/// (Catmull-Rom resampling, normal-based wall generation) is the same proven
/// algorithm used by <c>PoRacerTrackRegistry</c>; each track is defined by a
/// distinct set of hand-tuned knots plus a per-track <see cref="PoCabinetAtmosphere"/>.
///
/// <para>
/// All three tracks are closed loops with non-degenerate wall segments, so the
/// server sim tick can trust <see cref="PoCabinetTrackData.LoopLength"/> and
/// <see cref="PoCabinetTrackData.Walls"/> are valid for collision + lap counting.
/// </para>
/// </summary>
public static class PoCabinetTrackRegistry
{
    private static readonly Dictionary<string, PoCabinetTrackData> _tracks =
        new(StringComparer.OrdinalIgnoreCase);

    static PoCabinetTrackRegistry()
    {
        Register(BuildCapitolSpeedway());
        Register(BuildMarALagoGrandPrix());
        Register(BuildPressBriefing500());
    }

    private static void Register(PoCabinetTrackData track) => _tracks[track.Id] = track;

    /// <summary>Look up a track by id; returns the default track (Capitol Speedway) when null/unknown.</summary>
    public static PoCabinetTrackData GetTrack(string? trackId)
    {
        if (!string.IsNullOrWhiteSpace(trackId) && _tracks.TryGetValue(trackId, out var track))
        {
            return track;
        }
        return _tracks[PoCabinetCatalog.DefaultTrackId];
    }

    /// <summary>All registered tracks, in catalog order.</summary>
    public static IReadOnlyList<PoCabinetTrackData> All { get; } =
        PoCabinetCatalog.Tracks.Select(t => _tracks[t.Id]).ToList();

    // ──────────────────────────────────────────────────────────────────────
    //  Track 1: Capitol Speedway
    //  Symmetric pill oval, classical government-building backdrop.
    //  Cool blue sky, marble white ground, gold-trimmed accent (per Atmosphere).
    // ──────────────────────────────────────────────────────────────────────
    private static PoCabinetTrackData BuildCapitolSpeedway()
    {
        var rawKnots = new (double x, double y)[]
        {
            (0,     0),
            (380,   0),
            (760,   0),
            (1100,  60),
            (1300, 220),
            (1340, 420),
            (1220, 600),
            (1000, 700),
            (700,  720),
            (380,  720),
            (60,   700),
            (-160, 600),
            (-280, 420),
            (-260, 220),
            (-140,  60),
        };
        const double trackWidth = 220.0;
        var centerline = ResampleClosedSpline(rawKnots.Select(p => new Vec2(p.x, p.y)).ToList(), 12);
        var walls = GenerateWalls(centerline, trackWidth);

        return new PoCabinetTrackData
        {
            Id = "capitol",
            DisplayName = PoCabinetCatalog.GetTrack("capitol").Name,
            Description = PoCabinetCatalog.GetTrack("capitol").Description,
            TrackWidth = trackWidth,
            Centerline = centerline,
            Walls = walls,
            Atmosphere = new PoCabinetAtmosphere
            {
                SkyHex = "#0f1a3a",
                FogStart = 600,
                FogEnd = 2400,
                FogHex = "#1a274f",
                AmbientIntensity = 0.55,
                GroundHex = "#c8c2b3",        // marble
                AccentHex = "#d4af37",        // gold trim
            },
        };
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Track 2: Mar-a-Lago Grand Prix
    //  Palm-lined beachside course; one long oceanfront straight plus a sweeping
    //  inland loop. Warm peach sky, sand-tan ground, palm-green accent.
    // ──────────────────────────────────────────────────────────────────────
    private static PoCabinetTrackData BuildMarALagoGrandPrix()
    {
        var rawKnots = new (double x, double y)[]
        {
            (0,      0),
            (450,    0),
            (900,   -40),
            (1300, -180),
            (1500, -400),
            (1450, -640),
            (1200, -800),
            (800,  -840),
            (400,  -800),
            (50,  -700),
            (-220, -540),
            (-300, -340),
            (-220, -150),
            (-50,   -20),
        };
        const double trackWidth = 240.0;
        var centerline = ResampleClosedSpline(rawKnots.Select(p => new Vec2(p.x, p.y)).ToList(), 14);
        var walls = GenerateWalls(centerline, trackWidth);

        return new PoCabinetTrackData
        {
            Id = "maralago",
            DisplayName = PoCabinetCatalog.GetTrack("maralago").Name,
            Description = PoCabinetCatalog.GetTrack("maralago").Description,
            TrackWidth = trackWidth,
            Centerline = centerline,
            Walls = walls,
            Atmosphere = new PoCabinetAtmosphere
            {
                SkyHex = "#f7c79a",          // sunset peach
                FogStart = 700,
                FogEnd = 2800,
                FogHex = "#e89f6e",
                AmbientIntensity = 0.75,
                GroundHex = "#d4c084",        // beach sand
                AccentHex = "#2e7d4f",        // palm green
            },
        };
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Track 3: Press Briefing 500
    //  Stadium oval with a podium-shaped apex on the back straight (the "stage").
    //  Cool navy sky with stadium-light glow, slate podium floor, red-white accent.
    // ──────────────────────────────────────────────────────────────────────
    private static PoCabinetTrackData BuildPressBriefing500()
    {
        var rawKnots = new (double x, double y)[]
        {
            (0,      0),
            (300,   50),
            (600,  120),
            (900,  240),
            (1100, 380),
            (1180, 540),
            (1100, 700),
            (900,  820),
            (600,  860),
            (300,  820),
            (50,   720),
            (-130, 580),
            (-180, 400),
            (-100, 240),
            (50,   100),
        };
        const double trackWidth = 230.0;
        var centerline = ResampleClosedSpline(rawKnots.Select(p => new Vec2(p.x, p.y)).ToList(), 12);
        var walls = GenerateWalls(centerline, trackWidth);

        return new PoCabinetTrackData
        {
            Id = "pressbriefing",
            DisplayName = PoCabinetCatalog.GetTrack("pressbriefing").Name,
            Description = PoCabinetCatalog.GetTrack("pressbriefing").Description,
            TrackWidth = trackWidth,
            Centerline = centerline,
            Walls = walls,
            Atmosphere = new PoCabinetAtmosphere
            {
                SkyHex = "#0c1e3d",          // night-stadium navy
                FogStart = 500,
                FogEnd = 2200,
                FogHex = "#16294d",
                AmbientIntensity = 0.65,
                GroundHex = "#1f1f24",        // slate podium floor
                AccentHex = "#c0392b",        // podium red
            },
        };
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Spline + wall math (verbatim from PoRacerTrackRegistry; isolated here so
    //  PoCabinet does not import a PoRacer-specific feature namespace).
    // ──────────────────────────────────────────────────────────────────────

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

    /// <summary>Unit-length normal for the segment a→b (rotated 90° CCW).</summary>
    public static Vec2 ComputeNormal(Vec2 a, Vec2 b)
    {
        double dx = b.X - a.X, dy = b.Y - a.Y;
        double len = Math.Sqrt(dx * dx + dy * dy);
        if (len < 1e-9) return new Vec2(0, 1);
        return new Vec2(-dy / len, dx / len);
    }
}