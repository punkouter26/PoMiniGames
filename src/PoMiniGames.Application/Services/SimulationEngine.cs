namespace PoMiniGames.Application.Simulation;

using PoMiniGames.Application.Simulation;
using PoMiniGames.Domain.Entities.Simulation;
using PoMiniGames.Domain.Enums.Simulation;
using PoMiniGames.Shared.Simulation.Constants;

// GoF: Template Method — Tick() defines the invariant heartbeat algorithm; subclasses (if any) override steps
// SOLID: OCP — new resolution strategies can be injected without modifying the template
public sealed class SimulationEngine
{
    private const int Width = SimulationDefaults.GridWidth;
    private const int Height = SimulationDefaults.GridHeight;

    private readonly CombatService _combat;
    private readonly HungerService _hunger;
    private readonly GridService _grid;

    public SimulationEngine(CombatService combat, HungerService hunger, GridService grid)
    {
        _combat = combat;
        _hunger = hunger;
        _grid = grid;
    }

    /// <summary>
    /// Executes one heartbeat tick.
    /// Resolves all agent actions in ascending agent-ID lexicographic order.
    /// Returns a <see cref="TickResult"/> describing what happened this turn.
    /// </summary>
    public TickResult Tick(
        GridTile[] grid,
        List<Agent> agents,
        int turnNumber,
        SimulationConfig config,
        IReadOnlyDictionary<string, AgentAction> resolvedActions,
        Random rng)
    {
        var diedThisTurn = new List<string>();
        var witheredThisTurn = new List<(int X, int Y)>();

        // Step 1 — apply hunger to all alive agents (before actions)
        foreach (var a in agents.Where(a => a.IsAlive).OrderBy(a => a.Id))
        {
            _hunger.ApplyHunger(a, config);
            if (!a.IsAlive)
            {
                RemoveFromGrid(grid, a);
                diedThisTurn.Add(a.Id);
            }
        }

        // Step 2 — resolve actions in ID order (deterministic per spec)
        foreach (var agent in agents.Where(a => a.IsAlive).OrderBy(a => a.Id))
        {
            if (!resolvedActions.TryGetValue(agent.Id, out var action))
                action = AgentAction.Idle;

            agent.LastAction = action;

            switch (action)
            {
                case AgentAction.Attack:
                    ResolveAttack(grid, agent, agents, config, rng, diedThisTurn);
                    break;

                case AgentAction.Forage:
                    ResolveForage(grid, agent);
                    break;

                case AgentAction.Flee:
                    ResolveFlee(grid, agent, agents);
                    break;

                case AgentAction.Idle:
                    break;
            }
        }

        // Step 3 — wither old food
        witheredThisTurn = _grid.WitherFood(grid, turnNumber);

        // Step 4 — try to spawn new food
        _grid.TrySpawnFood(grid, turnNumber, config, rng);

        // Step 5 — check win condition
        var aliveRed = agents.Count(a => a.IsAlive && a.Team == TeamColor.Red);
        var aliveBlue = agents.Count(a => a.IsAlive && a.Team == TeamColor.Blue);

        SimulationOutcome? outcome = null;
        TeamColor? winner = null;

        if (aliveRed == 0 && aliveBlue == 0)
        {
            outcome = SimulationOutcome.Draw;
        }
        else if (aliveRed == 0)
        {
            outcome = SimulationOutcome.BlueWin;
            winner = TeamColor.Blue;
        }
        else if (aliveBlue == 0)
        {
            outcome = SimulationOutcome.RedWin;
            winner = TeamColor.Red;
        }
        else if (config.MaxTurns > 0 && turnNumber >= config.MaxTurns)
        {
            // Stalemate cap. Without this the ONLY exit was a total team wipe, so two
            // survivors who never became adjacent (Paranoid fleeing a Scavenger, both
            // topping up on food) ran the heartbeat forever — no outcome, no
            // post-mortem, no way out but a page reload. Reported as a Draw with
            // survivors still standing, which is what the post-mortem keys off to tell
            // a turn-limit draw apart from a mutual wipeout.
            outcome = SimulationOutcome.Draw;
        }

        return new TickResult(outcome, winner, diedThisTurn, witheredThisTurn);
    }

    // ─── Action resolvers ─────────────────────────────────────────────────────

    private void ResolveAttack(
        GridTile[] grid, Agent attacker, List<Agent> agents,
        SimulationConfig config, Random rng, List<string> diedThisTurn)
    {
        var enemies = agents
            .Where(a => a.IsAlive && a.Team != attacker.Team)
            .OrderBy(a => Manhattan(attacker.Position, a.Position))
            .ToList();

        if (enemies.Count == 0)
            return;

        var nearest = enemies[0];

        if (Manhattan(attacker.Position, nearest.Position) <= 1)
        {
            // Adjacent — attack
            _combat.Attack(attacker, nearest, config, rng);
            if (!nearest.IsAlive)
            {
                RemoveFromGrid(grid, nearest);
                diedThisTurn.Add(nearest.Id);
            }
        }
        else
        {
            // Move towards nearest enemy
            MoveTowards(grid, attacker, nearest.Position.X, nearest.Position.Y, rng);
        }
    }

    private void ResolveForage(GridTile[] grid, Agent agent)
    {
        // Check current tile first
        var currentTile = GridService.TileAt(grid, agent.Position.X, agent.Position.Y)!;
        if (currentTile.Food is not null)
        {
            _hunger.ConsumeFood(agent);
            currentTile.Food = null;
            return;
        }

        // Find nearest food
        GridTile? nearest = null;
        var bestDist = int.MaxValue;
        foreach (var tile in grid)
        {
            if (tile.Food is null) continue;
            var d = Manhattan(agent.Position, tile.X, tile.Y);
            if (d < bestDist)
            {
                bestDist = d;
                nearest = tile;
            }
        }

        if (nearest is null) return;

        MoveTowards(grid, agent, nearest.X, nearest.Y, null);
    }

    private void ResolveFlee(GridTile[] grid, Agent agent, List<Agent> agents)
    {
        var enemies = agents
            .Where(a => a.IsAlive && a.Team != agent.Team)
            .OrderBy(a => Manhattan(agent.Position, a.Position))
            .ToList();

        if (enemies.Count == 0)
            return;

        var threat = enemies[0];
        MoveAwayFrom(grid, agent, threat.Position.X, threat.Position.Y);
    }

    // ─── Movement helpers ─────────────────────────────────────────────────────

    private static void MoveTowards(GridTile[] grid, Agent agent, int targetX, int targetY, Random? rng)
    {
        var best = GetAdjacentTiles(grid, agent.Position.X, agent.Position.Y)
            .Where(t => t.Terrain == TerrainType.Empty && t.Occupant is null)
            .OrderBy(t => Manhattan(t.X, t.Y, targetX, targetY))
            .FirstOrDefault();

        if (best is null) return;
        MoveAgent(grid, agent, best);
    }

    private static void MoveAwayFrom(GridTile[] grid, Agent agent, int threatX, int threatY)
    {
        var best = GetAdjacentTiles(grid, agent.Position.X, agent.Position.Y)
            .Where(t => t.Terrain == TerrainType.Empty && t.Occupant is null)
            .OrderByDescending(t => Manhattan(t.X, t.Y, threatX, threatY))
            .FirstOrDefault();

        if (best is null) return;
        MoveAgent(grid, agent, best);
    }

    private static void MoveAgent(GridTile[] grid, Agent agent, GridTile dest)
    {
        var src = GridService.TileAt(grid, agent.Position.X, agent.Position.Y)!;
        src.Occupant = null;
        dest.Occupant = agent;
        agent.Position = new Domain.ValueObjects.Simulation.GridCoordinate(dest.X, dest.Y);
    }

    private static void RemoveFromGrid(GridTile[] grid, Agent agent)
    {
        var tile = GridService.TileAt(grid, agent.Position.X, agent.Position.Y);
        if (tile?.Occupant == agent)
            tile.Occupant = null;
    }

    private static IEnumerable<GridTile> GetAdjacentTiles(GridTile[] grid, int x, int y)
    {
        int[,] dirs = { { 0, -1 }, { 0, 1 }, { -1, 0 }, { 1, 0 } };
        for (var d = 0; d < 4; d++)
        {
            var tile = GridService.TileAt(grid, x + dirs[d, 0], y + dirs[d, 1]);
            if (tile is not null)
                yield return tile;
        }
    }

    private static int Manhattan(Domain.ValueObjects.Simulation.GridCoordinate pos, Domain.ValueObjects.Simulation.GridCoordinate other)
        => Math.Abs(pos.X - other.X) + Math.Abs(pos.Y - other.Y);

    private static int Manhattan(Domain.ValueObjects.Simulation.GridCoordinate pos, int x, int y)
        => Math.Abs(pos.X - x) + Math.Abs(pos.Y - y);

    private static int Manhattan(int x1, int y1, int x2, int y2)
        => Math.Abs(x1 - x2) + Math.Abs(y1 - y2);

}

/// <summary>Result produced by <see cref="SimulationEngine.Tick"/>.</summary>
public sealed record TickResult(
    SimulationOutcome? Outcome,
    TeamColor? WinningTeam,
    IReadOnlyList<string> DiedThisTurn,
    IReadOnlyList<(int X, int Y)> FoodWitheredThisTurn
);
