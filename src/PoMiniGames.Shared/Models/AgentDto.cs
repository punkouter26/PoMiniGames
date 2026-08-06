namespace PoMiniGames.Shared.Simulation.Models;

public record AgentDto(
    string Id,
    string Team,           // "Red" | "Blue"
    int Hp,
    float Hunger,
    int KillCount,
    float Predatory,
    float Scavenger,
    float Paranoid,
    float Altruistic,
    float Methodical,
    int X,
    int Y,
    bool IsAlive,
    bool IsFading,        // true when HP == 0 but not yet removed from grid (death animation)
    string? LastThought,
    string? LastAction,     // "Attack" | "Forage" | "Flee" | "Idle" | null
    int FoodConsumed,
    int TotalDamageDealt,
    int SurvivalTurns
);
