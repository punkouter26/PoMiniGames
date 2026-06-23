namespace PoSurvive.Domain.Entities;

using PoSurvive.Domain.Enums;
using PoSurvive.Domain.ValueObjects;

// GoF: Aggregate Root — encapsulates the lifecycle and summary of one simulation match
public sealed class SimulationSession
{
    public Guid                              SessionId         { get; }
    public DateTimeOffset                    StartedAt         { get; }
    public DateTimeOffset?                   EndedAt           { get; set; }
    public SimulationOutcome                 Outcome           { get; set; }
    public TeamColor?                        WinningTeam       { get; set; }
    public int                               TotalTurns        { get; set; }
    public int                               TotalFoodConsumed { get; set; }
    public int                               TotalDamageDealt  { get; set; }
    public IReadOnlyList<AgentFinalSnapshot> AgentSnapshots    { get; set; } = [];
    public SimulationConfigSnapshot          Config            { get; }

    public SimulationSession(
        Guid                    sessionId,
        SimulationConfigSnapshot config,
        DateTimeOffset?          startedAt = null)
    {
        SessionId = sessionId;
        Config    = config;
        StartedAt = startedAt ?? DateTimeOffset.UtcNow;
    }
}
