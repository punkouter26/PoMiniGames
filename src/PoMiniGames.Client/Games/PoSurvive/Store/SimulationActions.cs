namespace PoMiniGamesClient.Games.PoSurvive.Store;

using PoShared.Simulation.Models;

// ─── Session lifecycle ────────────────────────────────────────────────────────

/// <summary>Dispatched by MainLayout "START" button to initialise and run the simulation.</summary>
public sealed record StartSimulationAction(SimulationConfigDto Config, bool IsMockProvider);

/// <summary>Dispatched when simulation state is fully initialised (grid built, agents placed).</summary>
public sealed record SimulationInitialisedAction(
    Guid                          SessionId,
    IReadOnlyList<AgentDto>       Agents,
    IReadOnlyList<GridCoordinateDto> Rocks,
    SimulationConfigDto           Config,
    bool                          IsMockProvider);

/// <summary>Dispatched by the heartbeat timer to trigger a new turn.</summary>
public sealed record HeartbeatTickAction;

/// <summary>Dispatched by the orchestrator after computing a full tick.</summary>
public sealed record HeartbeatCompletedAction(
    int                           TurnNumber,
    IReadOnlyList<AgentDto>       Agents,
    IReadOnlyList<FoodNodeDto>    FoodNodes,
    IReadOnlyList<ConsoleEntry>   NewEntries,
    string?                       Outcome,
    string?                       WinningTeam,
    IReadOnlyList<HeartbeatEventDto> HeartbeatEvents);

/// <summary>Dispatched when at least one agent dies this turn (triggers audio).</summary>
public sealed record AgentDiedAction(string AgentId, string Team);

/// <summary>Dispatched when the simulation terminates and narrative is ready.</summary>
public sealed record PostMortemReadyAction(string NarrativeText, string? WinnerName);

/// <summary>Resets all simulation state and returns to IDLE.</summary>
public sealed record ResetSimulationAction;

/// <summary>Closes the post-mortem overlay while preserving run data for review.</summary>
public sealed record HidePostMortemAction;

// ─── God-Click ────────────────────────────────────────────────────────────────

/// <summary>Filters all panes to the clicked agent's data.</summary>
public sealed record GodClickSelectedAction(string AgentId);

/// <summary>Clears the God-Click filter (empty tile clicked).</summary>
public sealed record GodClickClearedAction;

/// <summary>Updates the tactical log event filter (all/errors/attack/forage/flee/idle).</summary>
public sealed record LogEventFilterChangedAction(string FilterKey);

// ─── Observer controls ────────────────────────────────────────────────────────

/// <summary>Updates the heartbeat interval in ms.</summary>
public sealed record SpeedChangedAction(int SpeedMs);

/// <summary>Pauses the simulation heartbeat without losing state.</summary>
public sealed record PauseSimulationAction;

/// <summary>Resumes the simulation heartbeat after a pause.</summary>
public sealed record ResumeSimulationAction;
