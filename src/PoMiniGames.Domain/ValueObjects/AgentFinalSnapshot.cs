namespace PoMiniGames.Domain.ValueObjects.Simulation;

using PoMiniGames.Domain.Enums.Simulation;

// GoF: Value Object — final per-agent stats captured when the session ends
public sealed record AgentFinalSnapshot(
    string    Id,
    TeamColor Team,
    int       Hp,
    int       KillCount,
    int       FoodConsumed,
    int       TotalDamageDealt,
    float     Predatory,
    float     Scavenger,
    float     Paranoid,
    float     Altruistic,
    float     Methodical,
    int       SurvivalTurns
);
