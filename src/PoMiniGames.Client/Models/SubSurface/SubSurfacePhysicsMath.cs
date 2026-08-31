using System.Numerics;
using System.Runtime.CompilerServices;

namespace PoMiniGamesClient.Models.SubSurface;

public static class SubSurfacePhysicsMath
{
    public const int GridWidth = 800;
    public const int GridHeight = 600;
    public const int TotalCells = GridWidth * GridHeight;
    public const float DefaultGravity = 9.81f;
    public const float WaterDensity = 1.0f;

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static int ToIndex(int x, int y) => (y * GridWidth) + x;

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static (int X, int Y) ToCoord(int index) => (index % GridWidth, index / GridWidth);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static (int X, int Y) Clamp(int x, int y)
    {
        var cx = Math.Clamp(x, 0, GridWidth - 1);
        var cy = Math.Clamp(y, 0, GridHeight - 1);
        return (cx, cy);
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static bool IsLateralDrainageColumn(int x) => x <= 0 || x >= GridWidth - 1;

    public static float CalculateCriticalSpan(float cohesion, float frictionAngleDeg, float soilDensity = 1.6f)
    {
        var phiRad = frictionAngleDeg * (MathF.PI / 180f);
        // Terzaghi / Mohr-Coulomb critical arching span L_crit = (2 * c / (gamma)) * tan(45 + phi/2)
        var factor = MathF.Tan((MathF.PI / 4f) + (phiRad / 2f));
        var gamma = MathF.Max(0.1f, soilDensity * 0.98f);
        return (2f * cohesion / gamma) * factor;
    }

    public static bool IsMohrCoulombArchStable(float spanWidth, float cohesion, float frictionAngleDeg, float soilDensity = 1.6f)
    {
        var critSpan = CalculateCriticalSpan(cohesion, frictionAngleDeg, soilDensity);
        return spanWidth <= critSpan;
    }

    public static float CalculateHydrostaticPressure(int waterColumnHeight, float density = WaterDensity, float gravity = DefaultGravity)
    {
        return density * gravity * waterColumnHeight;
    }

    public static Vector2 CalculateSlingshotLaunchVelocity(Vector2 dragStart, Vector2 dragCurrent, float powerMultiplier = 0.15f, float maxVelocity = 45f)
    {
        var pullVector = dragStart - dragCurrent;
        var velocity = pullVector * powerMultiplier;
        if (velocity.Length() > maxVelocity)
        {
            velocity = Vector2.Normalize(velocity) * maxVelocity;
        }
        return velocity;
    }
}
