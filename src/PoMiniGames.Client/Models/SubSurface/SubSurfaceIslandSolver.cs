using System.Collections.Generic;

namespace PoMiniGamesClient.Models.SubSurface;

public sealed record ConcreteIsland(
    List<(int X, int Y)> Cells,
    int MinX,
    int MaxX,
    int MinY,
    int MaxY);

public static class SubSurfaceIslandSolver
{
    private static readonly (int Dx, int Dy)[] Neighbors = [(0, 1), (0, -1), (1, 0), (-1, 0)];

    public static List<ConcreteIsland> FindConcreteIslands(byte[] grid, int width, int height)
    {
        var islands = new List<ConcreteIsland>();
        var visited = new bool[width * height];

        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                var idx = (y * width) + x;
                if (grid[idx] != (byte)SubSurfaceMaterial.Concrete || visited[idx])
                {
                    continue;
                }

                // BFS / Flood fill for contiguous concrete
                var islandCells = new List<(int X, int Y)>();
                var queue = new Queue<(int X, int Y)>();
                queue.Enqueue((x, y));
                visited[idx] = true;

                var minX = x;
                var maxX = x;
                var minY = y;
                var maxY = y;

                while (queue.Count > 0)
                {
                    var (currX, currY) = queue.Dequeue();
                    islandCells.Add((currX, currY));

                    if (currX < minX) minX = currX;
                    if (currX > maxX) maxX = currX;
                    if (currY < minY) minY = currY;
                    if (currY > maxY) maxY = currY;

                    // Check 4-connected neighbors
                    foreach (var (dx, dy) in Neighbors)
                    {
                        var nx = currX + dx;
                        var ny = currY + dy;
                        if (nx >= 0 && nx < width && ny >= 0 && ny < height)
                        {
                            var nIdx = (ny * width) + nx;
                            if (!visited[nIdx] && grid[nIdx] == (byte)SubSurfaceMaterial.Concrete)
                            {
                                visited[nIdx] = true;
                                queue.Enqueue((nx, ny));
                            }
                        }
                    }
                }

                islands.Add(new ConcreteIsland(islandCells, minX, maxX, minY, maxY));
            }
        }

        return islands;
    }

    public static bool IsIslandSupported(byte[] grid, int width, int height, ConcreteIsland island)
    {
        var islandSet = new HashSet<(int X, int Y)>(island.Cells);

        foreach (var (x, y) in island.Cells)
        {
            var belowY = y + 1;
            if (belowY >= height)
            {
                return true; // Reached bottom bedrock limit
            }

            if (islandSet.Contains((x, belowY)))
            {
                continue; // Part of self
            }

            var belowIdx = (belowY * width) + x;
            var belowMat = (SubSurfaceMaterial)grid[belowIdx];

            if (belowMat is SubSurfaceMaterial.Bedrock or SubSurfaceMaterial.CohesiveSand or SubSurfaceMaterial.Concrete)
            {
                return true;
            }
        }

        return false;
    }
}
