using System.Numerics;
using FluentAssertions;
using PoMiniGamesClient.Models.SubSurface;
using Xunit;

namespace PoMiniGames.Unit.SubSurface;

public class SubSurfaceBallisticsTests
{
    [Fact]
    public void BallisticsAndOrdnance_ValidateTrajectory_TNTFuse_AndBalloonImpact()
    {
        // Slingshot launch velocity
        var origin = new Vector2(400, 150);
        var drag = new Vector2(350, 200);
        var velocity = SubSurfaceBallistics.CalculateLaunch(origin, drag, multiplier: 0.2f);
        velocity.X.Should().BeGreaterThan(0);
        velocity.Y.Should().BeLessThan(0);

        // TNT submerged in water -> extinguished
        var tnt = new SubSurfaceProjectile(
            Type: ProjectileType.TNTBomb,
            Position: new Vector2(400, 310),
            Velocity: new Vector2(0, 5),
            TimerSeconds: 3.5f,
            IsExtinguished: false);
        var submerged = SubSurfaceBallistics.StepProjectile(tnt, isInWater: true, deltaSeconds: 0.1f);
        submerged.IsExtinguished.Should().BeTrue();
        submerged.TimerSeconds.Should().Be(3.5f);

        // TNT in dry air -> countdown to detonation
        var dryTNT = tnt with { TimerSeconds = 0.05f };
        var detonated = SubSurfaceBallistics.StepProjectile(dryTNT, isInWater: false, deltaSeconds: 0.1f);
        detonated.ShouldDetonate.Should().BeTrue();

        // Water balloon impact burst
        var balloon = new SubSurfaceProjectile(
            Type: ProjectileType.WaterBalloon,
            Position: new Vector2(400, 300),
            Velocity: new Vector2(10, 10),
            TimerSeconds: 0f,
            IsExtinguished: false);
        var bursted = SubSurfaceBallistics.CheckImpact(balloon, hasImpactedSolidOrFluid: true);
        bursted.ShouldBurstFluid.Should().BeTrue();
    }
}
