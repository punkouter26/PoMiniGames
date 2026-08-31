using FluentAssertions;
using PoMiniGamesClient.Models.SubSurface;
using Xunit;

namespace PoMiniGames.Unit.SubSurface;

public class SubSurfaceIslandSolverTests
{
    [Fact]
    public void IslandSolver_DetectsContiguousClusters_AndEvaluatesSupport()
    {
        // 5x5 mini-grid with a 3-cell horizontal concrete bar at (1,1), (2,1), (3,1)
        var width = 5;
        var height = 5;
        var grid = new byte[width * height];
        grid[1 * width + 1] = (byte)SubSurfaceMaterial.Concrete;
        grid[1 * width + 2] = (byte)SubSurfaceMaterial.Concrete;
        grid[1 * width + 3] = (byte)SubSurfaceMaterial.Concrete;

        var islands = SubSurfaceIslandSolver.FindConcreteIslands(grid, width, height);

        islands.Should().HaveCount(1);
        islands[0].Cells.Should().HaveCount(3);
        islands[0].MinX.Should().Be(1);
        islands[0].MaxX.Should().Be(3);

        // Air below -> unsupported
        SubSurfaceIslandSolver.IsIslandSupported(grid, width, height, islands[0]).Should().BeFalse();

        // Place sand beneath center cell -> supported
        grid[2 * width + 2] = (byte)SubSurfaceMaterial.CohesiveSand;
        SubSurfaceIslandSolver.IsIslandSupported(grid, width, height, islands[0]).Should().BeTrue();
    }
}
