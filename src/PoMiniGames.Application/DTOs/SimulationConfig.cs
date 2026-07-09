namespace PoMiniGames.Application.Simulation;

/// <summary>
/// Feature-flag-controlled simulation parameters.
/// Bound from the "Simulation" section of appsettings.json via IOptions&lt;SimulationConfig&gt;.
/// </summary>
public sealed class SimulationConfig
{
    public int   TeamSize              { get; set; } = 3;
    public float RockDensity           { get; set; } = 0.15f;
    public float FoodSpawnChance       { get; set; } = 0.10f;
    public int   FoodTtl               { get; set; } = 8;
    public float HungerDecayConstant   { get; set; } = 0.05f;
    public float HungerThreshold       { get; set; } = 0.80f;
    public int   StarveHpLossPerTurn   { get; set; } = 5;
    public int   BaseDamage            { get; set; } = 15;
    public int   HeartbeatMinMs        { get; set; } = 100;
    public int   HeartbeatMaxMs        { get; set; } = 2000;
    public int   InferenceTimeoutMs    { get; set; } = 10000;
    public int   MaxInferredAgentsPerTurn { get; set; } = 1;
}
