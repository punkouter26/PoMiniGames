namespace PoSurvive.Client.Services;

using Fluxor;
using PoSurvive.Client.Store;

/// <summary>Fluxor effect handler that delegates simulation commands to the orchestrator.</summary>
public sealed class SimulationEffects(SimulationOrchestrator orchestrator)
{
    [EffectMethod]
    public Task Handle(StartSimulationAction a, IDispatcher _)
    {
        orchestrator.Initialize(a.Config, a.IsMockProvider);
        return Task.CompletedTask;
    }

    [EffectMethod]
    public Task Handle(HeartbeatTickAction _, IDispatcher __)
        => orchestrator.TickAsync();

    [EffectMethod]
    public Task Handle(SpeedChangedAction a, IDispatcher _)
    {
        orchestrator.SetSpeed(a.SpeedMs);
        return Task.CompletedTask;
    }

    [EffectMethod]
    public Task Handle(PauseSimulationAction _, IDispatcher __)
    {
        orchestrator.Pause();
        return Task.CompletedTask;
    }

    [EffectMethod]
    public Task Handle(ResumeSimulationAction _, IDispatcher __)
    {
        orchestrator.Resume();
        return Task.CompletedTask;
    }

    [EffectMethod]
    public Task Handle(ResetSimulationAction _, IDispatcher __)
    {
        orchestrator.Reset();
        return Task.CompletedTask;
    }
}
