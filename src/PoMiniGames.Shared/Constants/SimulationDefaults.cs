namespace PoMiniGames.Shared.Simulation.Constants;

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

    /// <summary>
    /// Starting turn interval. This is the value the "Balanced" speed chip reports, and
    /// the one a fresh <c>SimulationState</c> carries — the three used to disagree
    /// (state said 900, this said 1000, and the orchestrator actually started the timer
    /// at <see cref="HeartbeatMaxMs"/>, so every battle ran at 2000 ms while the UI
    /// highlighted Balanced). One constant now feeds all three.
    /// </summary>
    public const int DefaultHeartbeatMs = 900;

    public const int InferenceTimeoutMs = 15000;
    public const int MaxInferredAgentsPerTurn = 1;

    /// <summary>
    /// Hard turn ceiling. The engine only ended a match when a whole team was wiped, so
    /// two survivors that never became adjacent (a Flee/Forage stand-off) ran forever —
    /// there was no stalemate outcome at all. Reaching this cap resolves as a Draw.
    /// 300 matches <c>SurviveStore.MaxTurnHistory</c>, so a capped match is exactly as
    /// long as the charts can plot.
    /// </summary>
    public const int MaxTurns = 300;
}
