namespace PoMiniGamesClient.Games.PoSurvive.Store;

using PoShared.Simulation.Constants;
using PoShared.Simulation.Models;

/// <summary>Immutable view state for one running simulation session. Owned by SurviveStore.</summary>
public sealed record SimulationState
{
    // ─── Session identity ──────────────────────────────────────────────────
    public Guid SessionId { get; init; } = Guid.Empty;
    public DateTimeOffset StartedAt { get; init; }

    // ─── Grid snapshot (DTOs for rendering) ───────────────────────────────
    public IReadOnlyList<AgentDto> Agents { get; init; } = [];
    public IReadOnlyList<FoodNodeDto> FoodNodes { get; init; } = [];
    public IReadOnlyList<GridCoordinateDto> Rocks { get; init; } = [];
    public int TurnNumber { get; init; } = 0;

    // ─── Console log ──────────────────────────────────────────────────────
    public IReadOnlyList<ConsoleEntry> ConsoleLog { get; init; } = [];

    // ─── Turn series (charts) ─────────────────────────────────────────────
    // One snapshot per completed turn. The console log carries per-agent *events*
    // but nothing that can be plotted against time — every temporal signal in the
    // UI used to be a scrolling text row. This is the series the rail's charts
    // read; it is capped like ConsoleLog so a long run can't grow unbounded.
    public IReadOnlyList<TurnSnapshot> TurnHistory { get; init; } = [];

    // ─── God-Click filter ─────────────────────────────────────────────────
    public string? SelectedAgentId { get; init; }
    public string EventFilter { get; init; } = "all";

    // ─── Champion (pick-a-champion) ───────────────────────────────────────
    // The agent the user has adopted to root for. Persists across turns; drives
    // the champion HUD strip, auto-follow, and the champion-centric post-mortem.
    public string? ChampionAgentId { get; init; }

    // ─── Lifecycle flags ──────────────────────────────────────────────────
    public bool IsRunning { get; init; } = false;
    public string? Outcome { get; init; }       // "RedWin" | "BlueWin" | "Draw" | null
    public string? WinningTeam { get; init; }       // "Red" | "Blue" | null

    // ─── Post-mortem ──────────────────────────────────────────────────────
    public string? NarrativeText { get; init; }
    public bool ShowPostMortem { get; init; } = false;

    // ─── Observer controls ────────────────────────────────────────────────
    // One shared constant with the "Balanced" chip and the orchestrator's start interval.
    public int SpeedMs { get; init; } = SimulationDefaults.DefaultHeartbeatMs;
    public bool IsMockProvider { get; init; } = false;
    public bool IsPaused { get; init; } = false;

    // ─── Config snapshot (for session persist) ────────────────────────────
    public SimulationConfigDto? Config { get; init; }
}

/// <summary>One entry in the tactical console log.</summary>
public sealed record ConsoleEntry(
    int TurnNumber,
    string AgentId,
    string Team,
    string Thought,
    string Action
);

/// <summary>
/// One turn's plottable state. Team totals are pre-aggregated (the charts would
/// otherwise re-scan every agent on every render); <see cref="Vitals"/> keeps the
/// per-agent detail the champion vitals chart needs, since the champion can be
/// adopted mid-run and the series has to reach back to turn 1.
/// </summary>
public sealed record TurnSnapshot(
    int Turn,
    int RedAlive,
    int BlueAlive,
    int RedHp,
    int BlueHp,
    IReadOnlyList<AgentVitals> Vitals
);

/// <summary>Per-agent vitals for one turn. Hunger is 0..1 (see SimulationDefaults.HungerThreshold).</summary>
public sealed record AgentVitals(string Id, int Hp, float Hunger);
