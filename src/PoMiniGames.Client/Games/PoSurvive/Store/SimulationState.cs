namespace PoMiniGamesClient.Games.PoSurvive.Store;

using PoMiniGames.Shared.Simulation.Constants;
using PoMiniGames.Shared.Simulation.Models;

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

    // ─── Live provider health ─────────────────────────────────────────────
    // Refreshed every heartbeat from the orchestrator. Bootstrap's verdict used to be the ONLY
    // input to the status pill, so a relay that answered the availability probe and then failed
    // every actual call still rendered as "AI online".
    public bool IsProviderDegraded { get; init; } = false;
    public int ProviderConsecutiveFailures { get; init; } = 0;

    /// <summary>Agents whose action came from a real provider on the most recent turn.</summary>
    public int ModelDecisionsThisTurn { get; init; } = 0;

    /// <summary>Agents whose action came from the local fallback table on the most recent turn.</summary>
    public int FallbackDecisionsThisTurn { get; init; } = 0;

    // ─── Config snapshot (for session persist) ────────────────────────────
    public SimulationConfigDto? Config { get; init; }
}

/// <summary>One entry in the tactical console log.</summary>
/// <param name="Source">
/// Where this decision came from: <c>MODEL</c> when a provider actually chose it, or
/// <c>FALLBACK</c> when the orchestrator's trait table did (timeout, provider error, or an agent
/// outside this turn's round-robin slice).
/// </param>
/// <remarks>
/// <see cref="Source"/> exists because the two were indistinguishable downstream, and the UI
/// therefore presented one as the other: the Decision Inspector narrated "Paranoid 58% … favored
/// by risk cues, low survivability" over a thought that read "Inference timed out after 15000 ms",
/// attributing the fallback table's pick to a model that had never answered. Callers that only
/// have a thought string had been left to guess by keyword-matching it.
/// </remarks>
public sealed record ConsoleEntry(
    int TurnNumber,
    string AgentId,
    string Team,
    string Thought,
    string Action,
    string Source = DecisionSource.Model
);

/// <summary>Provenance values for <see cref="ConsoleEntry.Source"/>.</summary>
public static class DecisionSource
{
    /// <summary>A real provider chose this action.</summary>
    public const string Model = "MODEL";

    /// <summary>The local trait-driven fallback table chose it.</summary>
    public const string Fallback = "FALLBACK";
}

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
