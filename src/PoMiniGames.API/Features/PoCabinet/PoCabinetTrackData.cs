using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// 2D vector for PoCabinet track geometry. Mirrors PoRacer's <c>Vec2</c> shape so the
/// physics tick in <see cref="PoCabinetSim"/> can share math with PoRacer patterns
/// without conversion overhead. Sits in this file (not Shared) because PoRacer's Vec2 is
/// also local to its feature slice; mirroring that boundary keeps the slices independent.
/// </summary>
public readonly record struct Vec2(double X, double Y)
{
    public static Vec2 operator +(Vec2 a, Vec2 b) => new(a.X + b.X, a.Y + b.Y);
    public static Vec2 operator -(Vec2 a, Vec2 b) => new(a.X - b.X, a.Y - b.Y);
    public static Vec2 operator *(Vec2 a, double s) => new(a.X * s, a.Y * s);
    public double LengthSquared() => X * X + Y * Y;
    public double Length() => Math.Sqrt(LengthSquared());
}

/// <summary>
/// Per-track atmosphere descriptors. The client <c>scene.js</c> reads this when it
/// mounts the three.js scene so a single Atmosphere dictionary drives sky color,
/// fog density, ambient light, and ground material tint.
/// </summary>
public sealed class PoCabinetAtmosphere
{
    /// <summary>Top-of-sky hex color, used by <c>scene.js</c> as <c>scene.background</c>.</summary>
    public required string SkyHex { get; init; }
    /// <summary>Distance at which <c>THREE.Fog</c> starts fading the road.</summary>
    public required double FogStart { get; init; }
    /// <summary>Distance at which fog reaches full opacity.</summary>
    public required double FogEnd { get; init; }
    /// <summary>Fog hex color (matches sky near the horizon).</summary>
    public required string FogHex { get; init; }
    /// <summary>Ambient light intensity, 0–1.</summary>
    public required double AmbientIntensity { get; init; }
    /// <summary>Ground material primary tint (asphalt / sand / marble).</summary>
    public required string GroundHex { get; init; }
    /// <summary>Side-prop accent (curbs / palms / podium stripes).</summary>
    public required string AccentHex { get; init; }
}

/// <summary>
/// Immutable track definition. Tracks are closed Catmull-Rom splines (PoRacer pattern);
/// <see cref="PoCabinetTrackRegistry"/> pre-resamples them so the sim never has to
/// re-tessellate. Walls are segments derived from the centerline plus
/// <see cref="TrackWidth"/>; boost pads and surface zones are absent for v1 to keep
/// the cockpit-view experience focused on scenery + lines.
/// </summary>
public sealed class PoCabinetTrackData
{
    public required string Id { get; init; }
    public required string DisplayName { get; init; }
    public required string Description { get; init; }
    public required double TrackWidth { get; init; }
    public required IReadOnlyList<Vec2> Centerline { get; init; }
    public required IReadOnlyList<(Vec2 a, Vec2 b)> Walls { get; init; }
    public required PoCabinetAtmosphere Atmosphere { get; init; }

    /// <summary>Total closed-loop length in world units (sum of segment lengths).</summary>
    public double LoopLength
    {
        get
        {
            if (Centerline.Count < 2) return 0;
            double total = 0;
            for (var i = 0; i < Centerline.Count; i++)
            {
                var a = Centerline[i];
                var b = Centerline[(i + 1) % Centerline.Count];
                total += (b - a).Length();
            }
            return total;
        }
    }
}
