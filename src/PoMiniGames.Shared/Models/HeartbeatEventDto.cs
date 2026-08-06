namespace PoMiniGames.Shared.Simulation.Models;

public record HeartbeatEventDto(
    Guid SessionId,
    int TurnNumber,
    string AgentId,
    string Team,            // "Red" | "Blue"
    string ThoughtText,
    string ActionTaken,     // "Attack" | "Forage" | "Flee" | "Idle"
    int HpBefore,
    int HpAfter,
    float HungerBefore,
    float HungerAfter,
    string GridSnapshot     // JSON-serialised GridStateDto
);
