namespace PoMiniGames.Application.Simulation;

using PoMiniGames.Application.Simulation;
using PoMiniGames.Domain.Entities.Simulation;
using PoMiniGames.Domain.Enums.Simulation;
using PoMiniGames.Domain.ValueObjects.Simulation;
using PoShared.Simulation.Constants;

// SOLID: SRP — owns only grid generation, agent placement, food spawning, and food wither
public sealed class GridService
{
    private const int Width  = SimulationDefaults.GridWidth;
    private const int Height = SimulationDefaults.GridHeight;

    private static readonly PersonalityProfile[] PersonalityProfiles =
    [
        new("Hunter",       0.58f, 0.10f, 0.12f, 0.05f, 0.15f),
        new("Scavenger",    0.12f, 0.56f, 0.10f, 0.07f, 0.15f),
        new("Survivor",     0.10f, 0.18f, 0.54f, 0.04f, 0.14f),
        new("Strategist",   0.20f, 0.12f, 0.13f, 0.07f, 0.48f),
        new("Guardian",     0.11f, 0.11f, 0.16f, 0.49f, 0.13f),
        new("Balanced",     0.24f, 0.20f, 0.20f, 0.14f, 0.22f),
    ];

    /// <summary>
    /// Generates a 10×10 grid with rocks placed randomly according to RockDensity.
    /// Rocks are distributed so that they never form an impenetrable wall
    /// (simplified: just random placement without connectivity check for MVP).
    /// </summary>
    public GridTile[] GenerateGrid(SimulationConfig config, Random rng)
    {
        var grid     = new GridTile[Width * Height];
        var rockCount = (int)Math.Round(Width * Height * config.RockDensity);

        for (var i = 0; i < grid.Length; i++)
            grid[i] = new GridTile(i % Width, i / Width, TerrainType.Empty);

        var placed = 0;
        while (placed < rockCount)
        {
            var idx = rng.Next(grid.Length);
            if (grid[idx].Terrain == TerrainType.Empty)
            {
                grid[idx] = new GridTile(idx % Width, idx / Width, TerrainType.Rock);
                placed++;
            }
        }

        return grid;
    }

    /// <summary>Places agents on random empty, unoccupied tiles.</summary>
    public void PlaceAgents(GridTile[] grid, IReadOnlyList<Agent> agents, Random rng)
    {
        if (grid is null)
            throw new ArgumentNullException(nameof(grid), "Grid cannot be null.");
            
        if (agents is null || agents.Count == 0)
        {
            // No-op: nothing to place
            return;
        }
        
        var emptyTiles = grid
            .Where(t => t.Terrain == TerrainType.Empty && t.Occupant is null)
            .ToList();

        if (emptyTiles.Count < agents.Count)
        {
            // Recovery: try to place as many as possible
            var toPlace = Math.Min(emptyTiles.Count, agents.Count);
            for (var k = 0; k < toPlace; k++)
            {
                var tile = emptyTiles[k];
                var a    = agents[k];
                a.Position       = new GridCoordinate(tile.X, tile.Y);
                tile.Occupant    = a;
            }
            return;
        }

        // Shuffle then pick first N
        for (var i = emptyTiles.Count - 1; i > 0; i--)
        {
            var j = rng.Next(i + 1);
            (emptyTiles[i], emptyTiles[j]) = (emptyTiles[j], emptyTiles[i]);
        }

        for (var k = 0; k < agents.Count; k++)
        {
            var tile = emptyTiles[k];
            var a    = agents[k];
            a.Position       = new GridCoordinate(tile.X, tile.Y);
            tile.Occupant    = a;
        }
    }

    /// <summary>
    /// Creates the initial list of agents for both teams from the config.
    /// Each agent is assigned a personality archetype with slight per-agent jitter.
    /// </summary>
    public List<Agent> CreateAgents(SimulationConfig config, Random rng)
    {
        var agents = new List<Agent>();

        foreach (var (team, prefix) in new[] { (TeamColor.Red, "R"), (TeamColor.Blue, "B") })
        {
            var teamProfiles = PersonalityProfiles
                .OrderBy(_ => rng.Next())
                .ToArray();

            for (var i = 1; i <= config.TeamSize; i++)
            {
                var profile = teamProfiles[(i - 1) % teamProfiles.Length];
                var dna = BuildDnaFromProfile(profile, rng);
                agents.Add(new Agent($"{prefix}{i}", team, new GridCoordinate(0, 0), dna));
            }
        }

        return agents;
    }

    /// <summary>
    /// Attempts to spawn a food node on a random empty, unoccupied, food-free tile.
    /// Returns the tile index or -1 if spawn was not triggered or no tile available.
    /// </summary>
    public int TrySpawnFood(GridTile[] grid, int turnNumber, SimulationConfig config, Random rng)
    {
        if (rng.NextDouble() >= config.FoodSpawnChance)
            return -1;

        var candidates = grid
            .Where(t => t.Terrain == TerrainType.Empty && t.Occupant is null && t.Food is null)
            .ToList();

        if (candidates.Count == 0)
            return -1;

        var tile   = candidates[rng.Next(candidates.Count)];
        tile.Food  = new FoodNode(turnNumber, config.FoodTtl);
        return tile.Y * Width + tile.X;
    }

    /// <summary>Removes all food nodes whose TTL has expired.</summary>
    public List<(int X, int Y)> WitherFood(GridTile[] grid, int turnNumber)
    {
        if (grid is null)
            throw new ArgumentNullException(nameof(grid), "Grid cannot be null.");
            
        var withered = new List<(int, int)>();
        foreach (var tile in grid)
        {
            if (tile.Food?.IsWithered(turnNumber) == true)
            {
                withered.Add((tile.X, tile.Y));
                tile.Food = null;
            }
        }
        return withered;
    }

    /// <summary>Gets the tile at the given coordinates.</summary>
    public static GridTile? TileAt(GridTile[] grid, int x, int y)
    {
        if (x < 0 || x >= Width || y < 0 || y >= Height) return null;
        return grid[y * Width + x];
    }

    // ──────────────────────────────────────────────────────────────────────────

    private static PersonalityDna BuildDnaFromProfile(PersonalityProfile profile, Random rng)
    {
        // Add low jitter so agents of the same profile do not feel identical.
        float Jitter(float weight)
        {
            var delta = ((float)rng.NextDouble() - 0.5f) * 0.08f;
            return MathF.Max(0.01f, weight + delta);
        }

        float p = Jitter(profile.Predatory);
        float s = Jitter(profile.Scavenger);
        float q = Jitter(profile.Paranoid);
        float a = Jitter(profile.Altruistic);
        float m = Jitter(profile.Methodical);

        return new PersonalityDna(p, s, q, a, m);
    }

    private sealed record PersonalityProfile(
        string Name,
        float Predatory,
        float Scavenger,
        float Paranoid,
        float Altruistic,
        float Methodical);
}