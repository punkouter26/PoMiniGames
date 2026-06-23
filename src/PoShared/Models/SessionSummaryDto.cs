namespace PoSurvive.Shared.Models;

public record SessionSummaryDto(
    Guid                               SessionId,
    string                             Outcome,       // "RedWin" | "BlueWin" | "Draw"
    string?                            WinningTeam,   // "Red" | "Blue" | null
    int                                TotalTurns,
    int                                TotalFoodConsumed,
    int                                TotalDamageDealt,
    DateTimeOffset                     StartedAt,
    DateTimeOffset                     EndedAt,
    IReadOnlyList<AgentFinalSnapshotDto> Agents,
    SimulationConfigDto                Config
);
