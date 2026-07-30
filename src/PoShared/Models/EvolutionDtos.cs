namespace PoShared.Simulation.Models;

/// <summary>
/// Request body for <c>POST /api/evolution/record</c>.
/// </summary>
/// <remarks>
/// This pair of records used to be declared TWICE — once in the client's
/// <c>EvolutionClientService.cs</c> and once nested inside the server's
/// <c>EvolutionEndpoints</c> — with no shared definition, which is exactly the arrangement
/// the platform convention exists to prevent (shared wire models live in PoShared). Two
/// independent declarations of the same contract only agree by coincidence: renaming a
/// property on one side would compile clean on both and fail silently at the boundary.
/// </remarks>
public sealed record RecordEvolutionRequest(
    string SessionId,
    List<AgentEvolutionResult> Agents
);

/// <summary>Per-agent outcome recorded for DNA evolution tracking.</summary>
public sealed record AgentEvolutionResult(
    float Predatory,
    float Scavenger,
    float Paranoid,
    float Altruistic,
    float Methodical,
    string AgentId,
    string Team,
    bool IsWinner,
    int KillCount,
    int FoodConsumed,
    int DamageDealt
);
