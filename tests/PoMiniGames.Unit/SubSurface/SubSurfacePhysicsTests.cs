using FluentAssertions;
using PoMiniGamesClient.Models.SubSurface;
using Xunit;

namespace PoMiniGames.Unit.SubSurface;

public class SubSurfacePhysicsTests
{
    [Fact]
    public void GridDimensions_ShouldBe800x600()
    {
        SubSurfacePhysicsMath.GridWidth.Should().Be(800);
        SubSurfacePhysicsMath.GridHeight.Should().Be(600);
        SubSurfacePhysicsMath.TotalCells.Should().Be(480_000);
    }

    [Theory]
    [InlineData(0, 0, 0)]
    [InlineData(799, 0, 799)]
    [InlineData(0, 1, 800)]
    [InlineData(799, 599, 479_999)]
    public void CoordinateToIndex_ShouldCalculateCorrectOffset(int x, int y, int expectedIndex)
    {
        var index = SubSurfacePhysicsMath.ToIndex(x, y);
        index.Should().Be(expectedIndex);

        var (outX, outY) = SubSurfacePhysicsMath.ToCoord(index);
        outX.Should().Be(x);
        outY.Should().Be(y);
    }

    [Theory]
    [InlineData(-5, 10, 0, 10)]
    [InlineData(850, 10, 799, 10)]
    [InlineData(10, -10, 10, 0)]
    [InlineData(10, 650, 10, 599)]
    public void ClampCoordinates_ShouldKeepCoordsInsideGrid(int inX, int inY, int expectedX, int expectedY)
    {
        var (clampedX, clampedY) = SubSurfacePhysicsMath.Clamp(inX, inY);
        clampedX.Should().Be(expectedX);
        clampedY.Should().Be(expectedY);
    }

    [Fact]
    public void MaterialEnums_ShouldMatchSpecificationCellIDs()
    {
        ((byte)SubSurfaceMaterial.Air).Should().Be(0);
        ((byte)SubSurfaceMaterial.CohesiveSand).Should().Be(1);
        ((byte)SubSurfaceMaterial.Concrete).Should().Be(2);
        ((byte)SubSurfaceMaterial.Water).Should().Be(3);
        ((byte)SubSurfaceMaterial.Bedrock).Should().Be(4);
    }

    [Theory]
    [InlineData(5.0f, 10.0f, 30.0f, true)]  // Below critical span -> stable arch
    [InlineData(25.0f, 10.0f, 30.0f, false)] // Exceeds critical span -> shear failure / collapse
    public void MohrCoulomb_ShouldDetermineArchStability(float spanWidth, float cohesion, float frictionAngleDeg, bool shouldBeStable)
    {
        var isStable = SubSurfacePhysicsMath.IsMohrCoulombArchStable(spanWidth, cohesion, frictionAngleDeg);
        isStable.Should().Be(shouldBeStable);
    }

    [Fact]
    public void HydrostaticPressure_ShouldIncreaseWithDepth()
    {
        var pressureShallow = SubSurfacePhysicsMath.CalculateHydrostaticPressure(waterColumnHeight: 5);
        var pressureDeep = SubSurfacePhysicsMath.CalculateHydrostaticPressure(waterColumnHeight: 50);

        pressureDeep.Should().BeGreaterThan(pressureShallow);
    }

    [Fact]
    public void LateralDrainage_ShouldDetectBoundaries()
    {
        SubSurfacePhysicsMath.IsLateralDrainageColumn(0).Should().BeTrue();
        SubSurfacePhysicsMath.IsLateralDrainageColumn(799).Should().BeTrue();
        SubSurfacePhysicsMath.IsLateralDrainageColumn(400).Should().BeFalse();
    }
}
