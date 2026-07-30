using FluentAssertions;
using PoMiniGames.Application.Simulation;
using PoMiniGames.Domain.Entities.Simulation;
using PoMiniGames.Domain.Enums.Simulation;
using PoMiniGames.Domain.ValueObjects.Simulation;
using PoShared.Simulation.Constants;
using Xunit;

namespace PoMiniGames.Integration;

/// <summary>
/// PoSurvive's simulation core had no test of any kind — not in this tier, not in Unit, not
/// in E2E. SimulationEngine, CombatService and HungerService decide every outcome the game
/// reports, and nothing verified them.
/// </summary>
/// <remarks>
/// These live in the Integration tier only because the Unit tier is at exactly 100/100
/// methods (see <c>TestCountCeilingTests</c>) and the 100/50/25/25 rule forbids raising that
/// cap. They are hermetic — no Azurite, no host, no I/O — so they belong in Unit the moment
/// headroom appears there. Two grouped methods, not eight, for the same ceiling reason.
/// </remarks>
public sealed class PoSurviveSimulationTests
{
    private static SimulationEngine NewEngine()
    {
        var combat = new CombatService();
        var hunger = new HungerService();
        var grid = new GridService();
        return new SimulationEngine(combat, hunger, grid);
    }

    private static SimulationConfig Config(int maxTurns = SimulationDefaults.MaxTurns) => new()
    {
        TeamSize = 1,
        RockDensity = 0f,
        FoodSpawnChance = 0f,
        FoodTtl = 8,
        // Hunger off by default: these cases assert combat and termination, and a starvation
        // tick landing mid-scenario would decide them instead.
        HungerDecayConstant = 0f,
        HungerThreshold = 0.8f,
        StarveHpLossPerTurn = 5,
        BaseDamage = 15,
        MaxTurns = maxTurns,
    };

    // PersonalityDna L1-normalises its weights, so these are ratios, not absolutes: a
    // predatory-dominant agent lands ~0.71 after normalisation, which is what the combat
    // formula multiplies BaseDamage by.
    private static Agent NewAgent(string id, TeamColor team, int x, int y, int hp = 100, float predatory = 1.0f)
        => new(id, team, new GridCoordinate(x, y),
               new PersonalityDna(predatory, 0.1f, 0.1f, 0.1f, 0.1f), hp);

    private static GridTile[] EmptyGrid(IEnumerable<Agent> agents)
    {
        // X/Y/Terrain are construction-only on GridTile, so the grid is built, not mutated.
        var tiles = new GridTile[SimulationDefaults.GridWidth * SimulationDefaults.GridHeight];
        for (var y = 0; y < SimulationDefaults.GridHeight; y++)
            for (var x = 0; x < SimulationDefaults.GridWidth; x++)
                tiles[(y * SimulationDefaults.GridWidth) + x] = new GridTile(x, y, TerrainType.Empty);

        foreach (var a in agents)
            GridService.TileAt(tiles, a.Position.X, a.Position.Y)!.Occupant = a;

        return tiles;
    }

    /// <summary>
    /// Termination. The engine only ever ended a match by wiping a team, so a stand-off ran
    /// the heartbeat forever with no outcome and no post-mortem — <c>MaxTurns</c> is the
    /// stalemate exit that closes it. Also covers the two win conditions and the case the
    /// old code did handle (mutual wipeout is a Draw), so the cap can't regress them.
    /// </summary>
    [Theory]
    // Red alive, Blue dead on arrival -> RedWin.
    [InlineData(100, 0, 500, 1, "RedWin")]
    // Blue alive, Red dead -> BlueWin.
    [InlineData(0, 100, 500, 1, "BlueWin")]
    // Both dead -> Draw (no survivors).
    [InlineData(0, 0, 500, 1, "Draw")]
    // Both healthy and far apart, turn budget exhausted -> Draw by turn limit, NOT null.
    [InlineData(100, 100, 5, 5, "Draw")]
    // Both healthy, cap not yet reached -> still running.
    [InlineData(100, 100, 500, 1, null)]
    public void Tick_ResolvesOutcome_IncludingTurnLimitStalemate(
        int redHp, int blueHp, int maxTurns, int turnNumber, string? expectedOutcome)
    {
        var engine = NewEngine();
        // Opposite corners: far enough apart that Attack can only close distance, never land,
        // so nothing but the turn cap can end the healthy-vs-healthy cases.
        var red = NewAgent("R1", TeamColor.Red, 0, 0, redHp);
        var blue = NewAgent("B1", TeamColor.Blue, 9, 9, blueHp);
        var agents = new List<Agent> { red, blue };
        var grid = EmptyGrid(agents.Where(a => a.IsAlive));

        var result = engine.Tick(
            grid, agents, turnNumber, Config(maxTurns),
            new Dictionary<string, AgentAction> { ["R1"] = AgentAction.Attack, ["B1"] = AgentAction.Attack },
            new Random(1));

        result.Outcome?.ToString().Should().Be(expectedOutcome);

        if (expectedOutcome is "Draw" && redHp > 0 && blueHp > 0)
        {
            agents.Should().OnlyContain(a => a.IsAlive,
                because: "a turn-limit draw leaves survivors standing — that is what the " +
                         "post-mortem keys off to avoid claiming 'no survivors'");
        }
    }

    /// <summary>
    /// Damage, kill attribution and starvation. Verifies the HP floor the combat formula
    /// documents (<c>max(0, …)</c>) is actually enforced by the entity, that a kill credits
    /// the attacker exactly once and marks the victim fading, and that starvation only bites
    /// at or past the hunger threshold.
    /// </summary>
    [Fact]
    public void CombatAndHunger_ClampHp_AndAttributeKills()
    {
        var config = Config();
        var combat = new CombatService();
        var hunger = new HungerService();
        var rng = new Random(7);

        // A one-HP defender cannot be pushed below zero, and the kill lands on the attacker.
        var attacker = NewAgent("R1", TeamColor.Red, 0, 0);
        var defender = NewAgent("B1", TeamColor.Blue, 0, 1, hp: 1);

        var dealt = combat.Attack(attacker, defender, config, rng);

        dealt.Should().BeGreaterThan(0, because: "the formula floors damage at 1");
        defender.Hp.Should().Be(0, because: "Agent.Hp clamps to [0,100]; HP must never render negative");
        defender.IsAlive.Should().BeFalse();
        defender.IsFading.Should().BeTrue(because: "the board's death animation keys off IsFading");
        attacker.KillCount.Should().Be(1);
        attacker.TotalDamageDealt.Should().Be(dealt);

        // Starvation: below the threshold hunger accrues with no HP cost; at or past it, HP drops.
        var faster = new SimulationConfig
        {
            HungerDecayConstant = 0.5f,
            HungerThreshold = 0.8f,
            StarveHpLossPerTurn = 5,
        };
        var starving = NewAgent("R2", TeamColor.Red, 2, 2);

        hunger.ApplyHunger(starving, faster);   // hunger 0.5 — under threshold
        starving.Hp.Should().Be(100, because: "hunger below the threshold costs no health");

        hunger.ApplyHunger(starving, faster);   // hunger 1.0 — at/over threshold
        starving.Hunger.Should().Be(1f, because: "hunger clamps to [0,1]");
        starving.Hp.Should().Be(95);

        hunger.ConsumeFood(starving);
        starving.Hunger.Should().Be(0f);
        starving.FoodConsumed.Should().Be(1);
    }
}
