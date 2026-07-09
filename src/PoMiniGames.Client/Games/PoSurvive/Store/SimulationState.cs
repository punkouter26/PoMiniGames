namespace PoMiniGamesClient.Games.PoSurvive.Store;

using Fluxor;
using PoShared.Simulation.Models;

/// <summary>Immutable view state for one running simulation session.</summary>
[FeatureState]
public sealed record SimulationState
{
    // ─── Session identity ──────────────────────────────────────────────────
    public Guid             SessionId    { get; init; } = Guid.Empty;
    public DateTimeOffset   StartedAt    { get; init; }

    // ─── Grid snapshot (DTOs for rendering) ───────────────────────────────
    public IReadOnlyList<AgentDto>         Agents     { get; init; } = [];
    public IReadOnlyList<FoodNodeDto>      FoodNodes  { get; init; } = [];
    public IReadOnlyList<GridCoordinateDto> Rocks     { get; init; } = [];
    public int                             TurnNumber { get; init; } = 0;

    // ─── Console log ──────────────────────────────────────────────────────
    public IReadOnlyList<ConsoleEntry>     ConsoleLog { get; init; } = [];

    // ─── God-Click filter ─────────────────────────────────────────────────
    public string? SelectedAgentId { get; init; }
    public string EventFilter { get; init; } = "all";

    // ─── Lifecycle flags ──────────────────────────────────────────────────
    public bool    IsRunning        { get; init; } = false;
    public string? Outcome          { get; init; }       // "RedWin" | "BlueWin" | "Draw" | null
    public string? WinningTeam      { get; init; }       // "Red" | "Blue" | null

    // ─── Post-mortem ──────────────────────────────────────────────────────
    public string? NarrativeText    { get; init; }
    public bool    ShowPostMortem   { get; init; } = false;

    // ─── Observer controls ────────────────────────────────────────────────
    public int     SpeedMs          { get; init; } = 900;  // matches BAL preset
    public bool    IsMockProvider   { get; init; } = false;
    public bool    IsPaused         { get; init; } = false;

    // ─── Config snapshot (for session persist) ────────────────────────────
    public SimulationConfigDto? Config { get; init; }
}

/// <summary>One entry in the tactical console log.</summary>
public sealed record ConsoleEntry(
    int    TurnNumber,
    string AgentId,
    string Team,
    string Thought,
    string Action
);
