namespace PoMiniGamesClient.Games.PoSurvive.Store;

using PoShared.Simulation.Models;

// The orchestrator owns the mutable domain model and runs on a timer thread; the store
// owns the immutable view state the UI binds to. These records are the handoff between
// them, and ISimulationSink is the one-way edge: the store depends on the orchestrator
// and registers itself as the sink, so the orchestrator never has to know the store exists.
//
// This replaces the Fluxor action/reducer/effect triple that used to carry the same data.

/// <summary>Grid built, agents placed — a new session is live.</summary>
public sealed record SimulationInitialised(
    Guid SessionId,
    IReadOnlyList<AgentDto> Agents,
    IReadOnlyList<GridCoordinateDto> Rocks,
    SimulationConfigDto Config,
    bool IsMockProvider);

/// <summary>One completed turn.</summary>
public sealed record HeartbeatCompleted(
    int TurnNumber,
    IReadOnlyList<AgentDto> Agents,
    IReadOnlyList<FoodNodeDto> FoodNodes,
    IReadOnlyList<ConsoleEntry> NewEntries,
    string? Outcome,
    string? WinningTeam,
    IReadOnlyList<HeartbeatEventDto> HeartbeatEvents);

/// <summary>An agent died this turn (drives the death cue).</summary>
public sealed record AgentDied(string AgentId, string Team);

/// <summary>The run ended and its narrative is ready.</summary>
public sealed record PostMortemReady(string NarrativeText, string? WinnerName);

/// <summary>Receives orchestrator output. Implemented by <see cref="SurviveStore"/>.</summary>
public interface ISimulationSink
{
    Task OnInitialisedAsync(SimulationInitialised e);
    Task OnHeartbeatAsync(HeartbeatCompleted e);
    Task OnAgentDiedAsync(AgentDied e);
    Task OnPostMortemAsync(PostMortemReady e);
}
