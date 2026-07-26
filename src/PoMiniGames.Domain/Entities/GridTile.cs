namespace PoMiniGames.Domain.Entities.Simulation;

using PoMiniGames.Domain.Enums.Simulation;

public sealed class GridTile
{
    private Agent? _occupant;
    private FoodNode? _food;

    public int X { get; }
    public int Y { get; }
    public TerrainType Terrain { get; }

    public Agent? Occupant
    {
        get => _occupant;
        set
        {
            if (value is not null && Terrain == TerrainType.Rock)
                throw new InvalidOperationException(
                    $"Tile ({X},{Y}) has Terrain=Rock and cannot be occupied.");
            _occupant = value;
        }
    }

    public FoodNode? Food
    {
        get => _food;
        set
        {
            if (value is not null && Terrain == TerrainType.Rock)
                throw new InvalidOperationException(
                    $"Tile ({X},{Y}) has Terrain=Rock and cannot hold food.");
            _food = value;
        }
    }

    public GridTile(int x, int y, TerrainType terrain = TerrainType.Empty)
    {
        X = x;
        Y = y;
        Terrain = terrain;
    }
}
