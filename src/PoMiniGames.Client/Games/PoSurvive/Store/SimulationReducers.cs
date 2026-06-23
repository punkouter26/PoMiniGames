namespace PoSurvive.Client.Store;

using Fluxor;

// All reducers are pure functions — they never mutate state, only produce new records.

public static class SimulationReducers
{
    private const int MaxConsoleEntries = 500;

    [ReducerMethod]
    public static SimulationState OnSimulationInitialised(
        SimulationState state, SimulationInitialisedAction a)
        => state with
        {
            SessionId      = a.SessionId,
            StartedAt      = DateTimeOffset.UtcNow,
            Agents         = a.Agents,
            FoodNodes      = [],
            Rocks          = a.Rocks,
            TurnNumber     = 0,
            ConsoleLog     = [],
            SelectedAgentId = null,
            EventFilter    = "all",
            IsRunning      = true,
            Outcome        = null,
            WinningTeam    = null,
            NarrativeText  = null,
            ShowPostMortem = false,
            Config         = a.Config,
            IsMockProvider = a.IsMockProvider,
        };

    [ReducerMethod]
    public static SimulationState OnHeartbeatCompleted(
        SimulationState state, HeartbeatCompletedAction a)
    {
        var log = state.ConsoleLog.Count + a.NewEntries.Count > MaxConsoleEntries
            ? state.ConsoleLog
                .Skip(state.ConsoleLog.Count + a.NewEntries.Count - MaxConsoleEntries)
                .Concat(a.NewEntries)
                .ToList()
            : state.ConsoleLog.Concat(a.NewEntries).ToList();

        return state with
        {
            TurnNumber  = a.TurnNumber,
            Agents      = a.Agents,
            FoodNodes   = a.FoodNodes,
            ConsoleLog  = log,
            Outcome     = a.Outcome,
            WinningTeam = a.WinningTeam,
            IsRunning   = a.Outcome is null,
        };
    }

    [ReducerMethod]
    public static SimulationState OnPostMortemReady(
        SimulationState state, PostMortemReadyAction a)
        => state with
        {
            NarrativeText  = a.NarrativeText,
            ShowPostMortem = true,
            IsRunning      = false,
        };

    [ReducerMethod]
    public static SimulationState OnResetSimulation(
        SimulationState state, ResetSimulationAction _)
        => new();

    [ReducerMethod]
    public static SimulationState OnHidePostMortem(
        SimulationState state, HidePostMortemAction _)
        => state with { ShowPostMortem = false };

    [ReducerMethod]
    public static SimulationState OnGodClickSelected(
        SimulationState state, GodClickSelectedAction a)
        => state with { SelectedAgentId = a.AgentId };

    [ReducerMethod]
    public static SimulationState OnGodClickCleared(
        SimulationState state, GodClickClearedAction _)
        => state with { SelectedAgentId = null };

    [ReducerMethod]
    public static SimulationState OnLogEventFilterChanged(
        SimulationState state, LogEventFilterChangedAction a)
        => state with { EventFilter = string.IsNullOrWhiteSpace(a.FilterKey) ? "all" : a.FilterKey.ToLowerInvariant() };

    [ReducerMethod]
    public static SimulationState OnSpeedChanged(
        SimulationState state, SpeedChangedAction a)
        => state with { SpeedMs = a.SpeedMs };

    [ReducerMethod]
    public static SimulationState OnPauseSimulation(
        SimulationState state, PauseSimulationAction _)
        => state with { IsPaused = true };

    [ReducerMethod]
    public static SimulationState OnResumeSimulation(
        SimulationState state, ResumeSimulationAction _)
        => state with { IsPaused = false };

}
