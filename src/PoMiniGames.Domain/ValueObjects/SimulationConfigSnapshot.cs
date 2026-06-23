namespace PoSurvive.Domain.ValueObjects;

// GoF: Value Object — snapshot of SimulationConfig captured at session creation
public sealed record SimulationConfigSnapshot(
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
