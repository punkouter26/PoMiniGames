using System.Collections.Concurrent;
using System.Globalization;

namespace PoMiniGames.Shared.Games;

/// <summary>
/// The daily circuit: one track per UTC day, the same for every player, generated from the date
/// (id <c>daily-yyyyMMdd</c>). A seeded loop of knots round an ellipse with one corner pinched in
/// tight, scaled to a ~3,200-unit lap, re-rolled until no part of it runs near another and no
/// corner is tighter than a car can take; then dressed like the hand-built tracks: hills,
/// banked corners, a wide braking zone, gravel and tarmac run-off, grip patches, and one of
/// their themes. Pure arithmetic (<see cref="PoCabinetDetMath"/>, its own RNG), so the browser
/// and the server build the same track from the id, which the lap verifier relies on.
/// </summary>
public static class PoCabinetDailyTrack
{
    public const string Prefix = "daily-";
    private const double TargetLength = 3200;
    private const int Steps = 12;
    private static readonly string[] Themes = ["capitol", "maralago", "senate", "pressbriefing"];
    private static readonly ConcurrentDictionary<string, PoCabinetTrackDefinition> Cache = new(StringComparer.OrdinalIgnoreCase);

    public static string IdFor(DateOnly day) => Prefix + day.ToString("yyyyMMdd", CultureInfo.InvariantCulture);

    /// <summary>Today's id (UTC).</summary>
    public static string TodayId(DateTime utcNow) => IdFor(DateOnly.FromDateTime(utcNow));

    public static bool TryParse(string? id, out DateOnly day)
    {
        day = default;
        var s = id?.Trim();
        return s is not null && s.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase)
            && DateOnly.TryParseExact(s[Prefix.Length..], "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out day);
    }

    /// <summary>A daily id players may race and post laps on: yesterday's (a race that ran over
    /// midnight), today's or tomorrow's (a clock a little ahead of the server's).</summary>
    public static bool IsCurrent(string? id, DateTime utcNow)
    {
        if (!TryParse(id, out var day)) return false;
        var today = DateOnly.FromDateTime(utcNow);
        return day >= today.AddDays(-1) && day <= today.AddDays(1);
    }

    public static string NameFor(DateOnly day) => "Daily Circuit · " + day.ToString("MMM d", CultureInfo.InvariantCulture);

    public static PoCabinetTrackDefinition Get(DateOnly day) => Cache.GetOrAdd(IdFor(day), _ => Build(day));

    private static PoCabinetTrackDefinition Build(DateOnly day)
    {
        uint seed = unchecked((uint)day.DayNumber * 2654435761u);
        for (uint attempt = 0; attempt < 200; attempt++)
        {
            var def = TryBuild(day, new Rng(unchecked(seed + attempt * 0x9E3779B9u)));
            if (def is not null) return def;
        }
        // Never seen in practice; an honest oval rather than no track.
        return TryBuild(day, new Rng(seed), plain: true)!;
    }

    private static PoCabinetTrackDefinition? TryBuild(DateOnly day, Rng rng, bool plain = false)
    {
        int n = plain ? 12 : 12 + (int)(rng.Next() * 5);
        double rx = 620 + rng.Next() * 260, ry = 330 + rng.Next() * 170;
        var r = new double[n];
        for (int k = 0; k < n; k++) r[k] = plain ? 1 : 1 + (rng.Next() - 0.55) * 0.5;
        if (!plain) r[(int)(rng.Next() * n)] *= 0.62; // one corner pinched in: the hairpin of the day
        for (int pass = 0; pass < 2; pass++)
        {
            var s = new double[n];
            for (int k = 0; k < n; k++) s[k] = (r[(k - 1 + n) % n] + r[k] * 2 + r[(k + 1) % n]) / 4;
            r = s;
        }
        var theta = new double[n];
        var knots = new (double X, double Y)[n];
        for (int k = 0; k < n; k++)
        {
            theta[k] = 2 * Math.PI * k / n + (plain ? 0 : (rng.Next() - 0.5) * 0.5 * (2 * Math.PI / n));
            knots[k] = (rx * r[k] * PoCabinetDetMath.Cos(theta[k]), ry * r[k] * PoCabinetDetMath.Sin(theta[k]));
        }

        // The line goes where the course runs straightest.
        var turn = Turns(knots);
        int start = 0;
        for (int k = 1; k < n; k++) if (Math.Abs(turn[k]) < Math.Abs(turn[start])) start = k;
        knots = [.. knots.Skip(start), .. knots.Take(start)];
        theta = [.. theta.Skip(start), .. theta.Take(start)];
        turn = Turns(knots);

        double width = 100 + Math.Floor(rng.Next() * 16);
        var probe = new PoCabinetTrackDefinition("daily", width, knots, Steps, new PoCabinetAtmosphereWire());
        double scale = TargetLength / Length(PoCabinetTrackGeometry.BuildCenterlineXY(probe));
        knots = knots.Select(p => (Math.Round(p.X * scale, 1), Math.Round(p.Y * scale, 1))).ToArray();
        if (!plain && !Valid(PoCabinetTrackGeometry.BuildCenterlineXY(probe with { Knots = knots }), width * 0.5)) return null;

        // Corners by how hard they turn, tightest first.
        var order = Enumerable.Range(0, n).OrderByDescending(k => Math.Abs(turn[k])).ThenBy(k => k).ToArray();
        int tight = order[0], second = order[1], third = order[2];

        // Hills: two waves round the loop, level at the line.
        double amp = 15 + rng.Next() * 40;
        int f1 = 1 + (int)(rng.Next() * 2), f2 = 2 + (int)(rng.Next() * 2);
        double p1 = rng.Next() * 2 * Math.PI, p2 = rng.Next() * 2 * Math.PI;
        var z = new double[n];
        for (int k = 0; k < n; k++)
        {
            z[k] = amp * (0.6 * PoCabinetDetMath.Sin(f1 * theta[k] + p1) + 0.4 * PoCabinetDetMath.Sin(f2 * theta[k] + p2));
        }
        double z0 = z[0];
        for (int k = 0; k < n; k++) z[k] = Math.Round(z[k] - z0, 1);

        // Banked into every real corner.
        var bank = new double[n];
        for (int k = 0; k < n; k++)
        {
            double t = turn[k];
            bank[k] = Math.Abs(t) > 0.3 ? Math.Round(-Math.Sign(t) * Math.Min(0.24, Math.Abs(t) * 0.3), 3) : 0;
        }

        // A wide braking zone into the tightest corner; a pinch on the straightest stretch away from the line.
        var widthMul = Enumerable.Repeat(1.0, n).ToArray();
        widthMul[(tight - 1 + n) % n] = 1.12;
        widthMul[tight] = 1.08;
        int pinch = Enumerable.Range(2, n - 3).OrderBy(k => Math.Abs(turn[k])).First();
        if (pinch != tight && pinch != (tight - 1 + n) % n) widthMul[pinch] = 0.92;

        string theme = Themes[(int)(rng.Next() * Themes.Length)];
        var themed = PoCabinetTrackGeometry.Get(theme);
        int Outside(int k) => turn[k] > 0 ? -1 : 1; // a right-hander's outside is its left
        var runoff = new List<PoCabinetRunoffZone>
        {
            new(Math.Max(0.5, tight - 1.0), Math.Min(n - 0.01, tight + 1.0), Outside(tight), PoCabinetRunoff.Gravel),
            new(Math.Max(0.5, second - 0.8), Math.Min(n - 0.01, second + 0.8), Outside(second), PoCabinetRunoff.Gravel),
            new(Math.Max(0.5, third - 0.7), Math.Min(n - 0.01, third + 0.7), 0, PoCabinetRunoff.Tarmac),
        };
        double Spot() => 1 + Math.Floor(rng.Next() * (n - 2) * 4) / 4;
        double a = Spot(), b = Spot();
        var patches = new List<PoCabinetPatchDef>
        {
            new(0.3, 1.6, -1, 1, 1.03, 1.02, "resurfaced"),
            new(Math.Min(n - 0.6, tight + 0.3), Math.Min(n - 0.01, tight + 0.9), -1, 1, 0.92, 0.86, "dusty"),
            new(a, Math.Min(n - 0.01, a + 0.5), -0.7, -0.1, 1, 0.7, "puddle"),
            new(b, Math.Min(n - 0.01, b + 0.5), 0.1, 0.7, 1, 0.72, "puddle"),
        };

        return new PoCabinetTrackDefinition(IdFor(day), width, knots, Steps, themed.Atmosphere)
        {
            KnotZ = z,
            KnotBank = bank,
            KnotWidth = widthMul,
            DefaultRunoff = theme == "pressbriefing" ? PoCabinetRunoff.Tarmac : PoCabinetRunoff.Grass,
            Runoff = runoff,
            Patches = patches,
            Theme = theme,
        };
    }

    /// <summary>Signed turn at each knot (+ = right, heading increasing), radians.</summary>
    private static double[] Turns((double X, double Y)[] k)
    {
        int n = k.Length;
        var t = new double[n];
        for (int i = 0; i < n; i++)
        {
            var p = k[(i - 1 + n) % n];
            var c = k[i];
            var q = k[(i + 1) % n];
            double d = PoCabinetDetMath.Atan2(q.Y - c.Y, q.X - c.X) - PoCabinetDetMath.Atan2(c.Y - p.Y, c.X - p.X);
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d <= -Math.PI) d += 2 * Math.PI;
            t[i] = d;
        }
        return t;
    }

    private static double Length(double[] xy)
    {
        int n = xy.Length / 2;
        double len = 0;
        for (int i = 0; i < n; i++)
        {
            int j = (i + 1) % n;
            double dx = xy[j * 2] - xy[i * 2], dy = xy[j * 2 + 1] - xy[i * 2 + 1];
            len += Math.Sqrt(dx * dx + dy * dy);
        }
        return len;
    }

    /// <summary>No corner tighter than a car can take, and no stretch of the course near another:
    /// two parts of the lap further apart along it than a few road widths must be further apart on
    /// the ground than both run-offs and a gap.</summary>
    private static bool Valid(double[] xy, double hw)
    {
        int n = xy.Length / 2;
        var cum = new double[n + 1];
        for (int i = 0; i < n; i++)
        {
            int j = (i + 1) % n;
            double dx = xy[j * 2] - xy[i * 2], dy = xy[j * 2 + 1] - xy[i * 2 + 1];
            cum[i + 1] = cum[i] + Math.Sqrt(dx * dx + dy * dy);
        }
        double length = cum[n];
        for (int i = 0; i < n; i++)
        {
            int p = (i - 1 + n) % n, q = (i + 1) % n;
            double h0 = PoCabinetDetMath.Atan2(xy[i * 2 + 1] - xy[p * 2 + 1], xy[i * 2] - xy[p * 2]);
            double h1 = PoCabinetDetMath.Atan2(xy[q * 2 + 1] - xy[i * 2 + 1], xy[q * 2] - xy[i * 2]);
            double d = h1 - h0;
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d <= -Math.PI) d += 2 * Math.PI;
            double span = (cum[i + 1] - cum[i] + (i > 0 ? cum[i] - cum[i - 1] : length - cum[n - 1])) * 0.5;
            if (Math.Abs(d) / Math.Max(1e-6, span) > 1 / 70.0) return false;
        }
        double clear = 2 * (hw + 40) + 40;
        for (int i = 0; i < n; i++)
        {
            for (int j = i + 1; j < n; j++)
            {
                double along = cum[j] - cum[i];
                if (Math.Min(along, length - along) < hw * 6) continue;
                double dx = xy[j * 2] - xy[i * 2], dy = xy[j * 2 + 1] - xy[i * 2 + 1];
                if (dx * dx + dy * dy < clear * clear) return false;
            }
        }
        return true;
    }

    /// <summary>mulberry32: a small seeded generator with no runtime dependence.</summary>
    private sealed class Rng(uint seed)
    {
        private uint _s = seed;

        public double Next()
        {
            unchecked
            {
                _s += 0x6D2B79F5u;
                uint t = _s;
                t = (t ^ (t >> 15)) * (t | 1);
                t ^= t + (t ^ (t >> 7)) * (t | 61);
                return (t ^ (t >> 14)) / 4294967296.0;
            }
        }
    }
}
