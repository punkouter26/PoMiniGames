using System.Numerics;

namespace PoMiniGamesClient.Models.SubSurface;

public enum ProjectileType : byte
{
    TNTBomb = 0,
    WaterBalloon = 1
}

public sealed record SubSurfaceProjectile(
    ProjectileType Type,
    Vector2 Position,
    Vector2 Velocity,
    float TimerSeconds,
    bool IsExtinguished,
    bool ShouldDetonate = false,
    bool ShouldBurstFluid = false)
{
    public const float TNTFuseDuration = 5.0f;
}

public static class SubSurfaceBallistics
{
    public static Vector2 CalculateLaunch(Vector2 origin, Vector2 drag, float multiplier = 0.2f, float maxVelocity = 40f)
    {
        var dir = origin - drag;
        var vel = dir * multiplier;
        if (vel.Length() > maxVelocity)
        {
            vel = Vector2.Normalize(vel) * maxVelocity;
        }
        return vel;
    }

    public static SubSurfaceProjectile StepProjectile(SubSurfaceProjectile proj, bool isInWater, float deltaSeconds)
    {
        if (proj.Type == ProjectileType.TNTBomb)
        {
            if (isInWater)
            {
                // Contact with water extinguishes the fuse permanently
                return proj with { IsExtinguished = true, ShouldDetonate = false };
            }

            if (!proj.IsExtinguished)
            {
                var remaining = proj.TimerSeconds - deltaSeconds;
                if (remaining <= 0)
                {
                    return proj with { TimerSeconds = 0, ShouldDetonate = true };
                }
                return proj with { TimerSeconds = remaining };
            }
        }

        return proj;
    }

    public static SubSurfaceProjectile CheckImpact(SubSurfaceProjectile proj, bool hasImpactedSolidOrFluid)
    {
        if (proj.Type == ProjectileType.WaterBalloon && hasImpactedSolidOrFluid)
        {
            return proj with { ShouldBurstFluid = true };
        }
        return proj;
    }
}
