namespace PoShared.Simulation.Models;

public record SimulationConfigDto(
    int   TeamSize,
    float RockDensity,
    float FoodSpawnChance,
    int   FoodTtl,
    float HungerDecayConstant,
    float HungerThreshold,
    int   StarveHpLossPerTurn,
    int   BaseDamage,
    int   HeartbeatMinMs,
    int   HeartbeatMaxMs,
    int   InferenceTimeoutMs,
    int   MaxInferredAgentsPerTurn
);
