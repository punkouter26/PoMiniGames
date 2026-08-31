using FluentAssertions;
using PoMiniGamesClient.Models.SubSurface;
using Xunit;

namespace PoMiniGames.Unit.SubSurface;

public class SubSurfacePhysicsTests
{
    [Theory]
    [InlineData(0, 0, 0, true, 10f, 30f, true)]
    [InlineData(799, 599, 479_999, true, 25f, 30f, false)]
    [InlineData(400, 300, 240_400, false, 5f, 30f, true)]
    public void PhysicsMath_GridAndMohrCoulomb_ValidateCorrectly(
        int x, int y, int expectedIndex, bool isLateral, float span, float friction, bool expectedStable)
    {
        // Grid dimension & bounds validation
        SubSurfacePhysicsMath.GridWidth.Should().Be(800);
        SubSurfacePhysicsMath.GridHeight.Should().Be(600);
        SubSurfacePhysicsMath.TotalCells.Should().Be(480_000);

        SubSurfacePhysicsMath.ToIndex(x, y).Should().Be(expectedIndex);
        var (outX, outY) = SubSurfacePhysicsMath.ToCoord(expectedIndex);
        outX.Should().Be(x);
        outY.Should().Be(y);

        var (clampedX, clampedY) = SubSurfacePhysicsMath.Clamp(x + 1000, y - 1000);
        clampedX.Should().Be(799);
        clampedY.Should().Be(0);

        // Material IDs
        ((byte)SubSurfaceMaterial.Air).Should().Be(0);
        ((byte)SubSurfaceMaterial.CohesiveSand).Should().Be(1);
        ((byte)SubSurfaceMaterial.Concrete).Should().Be(2);
        ((byte)SubSurfaceMaterial.Water).Should().Be(3);
        ((byte)SubSurfaceMaterial.Bedrock).Should().Be(4);

        // Lateral drainage & Mohr-Coulomb
        SubSurfacePhysicsMath.IsLateralDrainageColumn(x).Should().Be(isLateral);
        SubSurfacePhysicsMath.IsMohrCoulombArchStable(span, 10f, friction).Should().Be(expectedStable);
        SubSurfacePhysicsMath.CalculateHydrostaticPressure(50).Should().BeGreaterThan(SubSurfacePhysicsMath.CalculateHydrostaticPressure(5));
    }
}
