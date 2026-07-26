namespace PoShared.Simulation.Constants;

/// <summary>Typed constants for all default simulation parameters (mirrors appsettings.json defaults).</summary>
public static class SimulationDefaults
{
    public const int TeamSize = 3;
    public const int TeamSizeMin = 2;
    public const int TeamSizeMax = 5;

    public const int GridWidth = 10;
    public const int GridHeight = 10;

    public const float RockDensity = 0.15f;
    public const float FoodSpawnChance = 0.10f;
    public const int FoodTtl = 8;

    public const float HungerDecayConstant = 0.05f;
    public const float HungerThreshold = 0.80f;
    public const int StarveHpLossPerTurn = 5;

    public const int BaseDamage = 15;
    public const int AgentStartingHp = 100;

    public const int HeartbeatMinMs = 100;
    public const int HeartbeatMaxMs = 2000;
    public const int DefaultHeartbeatMs = 1000;
    public const int InferenceTimeoutMs = 15000;
    public const int MaxInferredAgentsPerTurn = 1;
}
