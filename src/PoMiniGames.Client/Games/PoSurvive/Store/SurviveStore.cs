namespace PoMiniGamesClient.Games.PoSurvive.Store;

using PoMiniGamesClient.Games.PoSurvive.Services;
using PoShared.Simulation.Models;

/// <summary>
/// The single owner of PoSurvive's view state.
///
/// Replaces the Fluxor store this slice used to carry (6 action/reducer/state files, 3
/// effect classes, and a Redux dependency the rest of the platform never used). The
/// shape is unchanged in spirit — state records stay immutable and every transition is
/// still `state with { … }` — but a command is now a method instead of a record plus a
/// reducer plus a registration scan, and a side effect is a call instead of a
/// convention-bound handler.
///
/// Threading: <see cref="Changed"/> fires on whatever thread made the transition, which
/// for heartbeats is the orchestrator's timer thread. Components must marshal — that is
/// what <c>SurviveComponentBase</c> / <c>SurviveLayoutBase</c> do.
/// </summary>
public sealed class SurviveStore : ISimulationSink, IDisposable
{
    private const int MaxConsoleEntries = 500;

    // Charts render every point they are given, so the cap is a render budget, not
    // just a memory one. 300 turns at ~1 point/px is already wider than the rail.
    private const int MaxTurnHistory = 300;

    private readonly SimulationOrchestrator _orchestrator;
    private readonly AudioCues _audio;
    private readonly SessionLogService _log;

    public SimulationState Simulation { get; private set; } = new();
    public BootState Boot { get; private set; } = new();

    /// <summary>Raised after any state transition.</summary>
    public event Action? Changed;

    public SurviveStore(SimulationOrchestrator orchestrator, AudioCues audio, SessionLogService log)
    {
        _orchestrator = orchestrator;
        _audio = audio;
        _log = log;
        _orchestrator.Sink = this;
    }

    private void Emit() => Changed?.Invoke();

    // ─── Simulation commands (UI → store) ─────────────────────────────────

    public void StartSimulation(SimulationConfigDto config, bool isMockProvider)
        => _orchestrator.Initialize(config, isMockProvider);

    public void ResetSimulation()
    {
        _orchestrator.Reset();
        Simulation = new SimulationState();
        Emit();
        _ = _audio.OnResetAsync();
    }

    public void HidePostMortem()
    {
        Simulation = Simulation with { ShowPostMortem = false };
        Emit();
    }

    public void SelectAgent(string agentId)
    {
        Simulation = Simulation with { SelectedAgentId = agentId };
        Emit();
    }

    public void ClearSelection()
    {
        Simulation = Simulation with { SelectedAgentId = null };
        Emit();
    }

    /// <summary>
    /// Adopt an agent as the user's champion (also follows it in the inspector).
    /// Passing null drops the champion and leaves the current follow untouched.
    /// </summary>
    public void SelectChampion(string? agentId)
    {
        Simulation = Simulation with
        {
            ChampionAgentId = agentId,
            SelectedAgentId = agentId ?? Simulation.SelectedAgentId,
        };
        Emit();
    }

    public void SetLogFilter(string filterKey)
    {
        Simulation = Simulation with
        {
            EventFilter = string.IsNullOrWhiteSpace(filterKey) ? "all" : filterKey.ToLowerInvariant(),
        };
        Emit();
    }

    public void SetSpeed(int speedMs)
    {
        Simulation = Simulation with { SpeedMs = speedMs };
        Emit();
        _orchestrator.SetSpeed(speedMs);
    }

    public void Pause()
    {
        Simulation = Simulation with { IsPaused = true };
        Emit();
        _orchestrator.Pause();
    }

    public void Resume()
    {
        Simulation = Simulation with { IsPaused = false };
        Emit();
        _orchestrator.Resume();
    }

    // ─── Boot commands (UI → store) ───────────────────────────────────────

    public void GpuProbeCompleted(string gpuLabel, bool isMockProvider)
    {
        Boot = Boot with { GpuLabel = gpuLabel, IsMockProvider = isMockProvider };
        Emit();
    }

    public void ModelLoadProgress(long bytesLoaded, long totalBytes)
    {
        Boot = Boot with { BytesLoaded = bytesLoaded, TotalBytes = totalBytes };
        Emit();
    }

    public void InferenceConfigured(string providerKind, string modelId, string modelLabel)
    {
        Boot = Boot with { ProviderKind = providerKind, ModelId = modelId, ModelLabel = modelLabel };
        Emit();
    }

    public void InferenceInitFailed(string error)
    {
        Boot = Boot with { HasInferenceInitError = true, InferenceInitError = error };
        Emit();
    }

    public void ContinueDegradedMode()
    {
        Boot = Boot with { IsDegradedMode = true, IsReady = true };
        Emit();
    }

    /// <summary>Clears readiness/error/progress so a newly selected model can re-initialise.</summary>
    public void ResetInferenceBootstrap()
    {
        Boot = Boot with
        {
            BytesLoaded = 0,
            TotalBytes = 0,
            IsReady = false,
            IsDegradedMode = false,
            HasInferenceInitError = false,
            InferenceInitError = null,
        };
        Emit();
    }

    public void BootReady()
    {
        Boot = Boot with { IsReady = true };
        Emit();
    }

    // ─── ISimulationSink (orchestrator → store) ───────────────────────────

    public async Task OnInitialisedAsync(SimulationInitialised e)
    {
        Simulation = new SimulationState
        {
            SessionId = e.SessionId,
            StartedAt = DateTimeOffset.UtcNow,
            Agents = e.Agents,
            Rocks = e.Rocks,
            IsRunning = true,
            Config = e.Config,
            IsMockProvider = e.IsMockProvider,
            // SpeedMs deliberately carried over so a mid-session speed choice survives
            // the next Start; everything else resets to the record defaults.
            SpeedMs = Simulation.SpeedMs,
        };
        Emit();

        await _log.OpenSessionAsync(e.SessionId);
        await _audio.OnInitialisedAsync();
    }

    public async Task OnHeartbeatAsync(HeartbeatCompleted e)
    {
        var combined = Simulation.ConsoleLog.Count + e.NewEntries.Count;
        var log = combined > MaxConsoleEntries
            ? Simulation.ConsoleLog.Skip(combined - MaxConsoleEntries).Concat(e.NewEntries).ToList()
            : Simulation.ConsoleLog.Concat(e.NewEntries).ToList();

        Simulation = Simulation with
        {
            TurnNumber = e.TurnNumber,
            Agents = e.Agents,
            FoodNodes = e.FoodNodes,
            ConsoleLog = log,
            TurnHistory = AppendSnapshot(Simulation.TurnHistory, e),
            Outcome = e.Outcome,
            WinningTeam = e.WinningTeam,
            IsRunning = e.Outcome is null,
        };
        Emit();

        foreach (var evt in e.HeartbeatEvents)
            await _log.AppendAsync(evt);

        await _audio.OnHeartbeatAsync(e.NewEntries, e.Outcome);
    }

    /// <summary>
    /// Appends one plottable snapshot per turn. A heartbeat that re-reports the turn
    /// already at the tail *replaces* it rather than appending — the orchestrator can
    /// emit twice for one turn (deferred inference lands late), and a duplicated x
    /// value would draw a vertical spike through every series.
    /// </summary>
    private static IReadOnlyList<TurnSnapshot> AppendSnapshot(
        IReadOnlyList<TurnSnapshot> history, HeartbeatCompleted e)
    {
        var snapshot = new TurnSnapshot(
            Turn: e.TurnNumber,
            RedAlive: e.Agents.Count(a => a.IsAlive && a.Team == "Red"),
            BlueAlive: e.Agents.Count(a => a.IsAlive && a.Team == "Blue"),
            RedHp: e.Agents.Where(a => a.Team == "Red").Sum(a => a.Hp),
            BlueHp: e.Agents.Where(a => a.Team == "Blue").Sum(a => a.Hp),
            Vitals: e.Agents.Select(a => new AgentVitals(a.Id, a.Hp, a.Hunger)).ToList());

        if (history.Count > 0 && history[^1].Turn == snapshot.Turn)
            return [.. history.Take(history.Count - 1), snapshot];

        return history.Count >= MaxTurnHistory
            ? [.. history.Skip(history.Count - MaxTurnHistory + 1), snapshot]
            : [.. history, snapshot];
    }

    public Task OnAgentDiedAsync(AgentDied e) => _audio.OnAgentDiedAsync();

    public async Task OnPostMortemAsync(PostMortemReady e)
    {
        Simulation = Simulation with
        {
            NarrativeText = e.NarrativeText,
            ShowPostMortem = true,
            IsRunning = false,
        };
        Emit();

        await _audio.OnPostMortemAsync(e.WinnerName is not null);
    }

    public void Dispose() => _orchestrator.Sink = null;
}
