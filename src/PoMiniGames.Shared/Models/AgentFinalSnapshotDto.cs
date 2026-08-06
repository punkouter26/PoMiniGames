namespace PoMiniGames.Shared.Simulation.Models;

public record AgentFinalSnapshotDto(
    string Id,
    string Team,            // "Red" | "Blue"
    int Hp,
    int KillCount,
    int FoodConsumed,
    int TotalDamageDealt,
    float Predatory,
    float Scavenger,
    float Paranoid,
    float Altruistic,
    float Methodical,
    int SurvivalTurns
);
