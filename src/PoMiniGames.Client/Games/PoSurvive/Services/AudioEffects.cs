namespace PoSurvive.Client.Services;

using Fluxor;
using PoSurvive.Client.Store;
using PoSurvive.Domain.Enums;

/// <summary>
/// Fluxor effects that trigger audio feedback from simulation events (T074).
/// Enhanced with Soundtrack Composer: ambient drone lifecycle, heartbeat intensity
/// scaling based on combat activity, and victory/defeat fanfares.
/// </summary>
public sealed class AudioEffects(AudioService audio)
{
    private bool _ambientStarted;

    [EffectMethod]
    public async Task Handle(SimulationInitialisedAction _, IDispatcher __)
    {
        // Start ambient drone when simulation begins
        await audio.StartAmbientAsync();
        await audio.StartHeartbeatAsync(intensity: 0.05f);
        _ambientStarted = true;
    }

    [EffectMethod]
    public Task Handle(AgentDiedAction _, IDispatcher __)
        => audio.PlayDeathAsync();

    [EffectMethod]
    public async Task Handle(HeartbeatCompletedAction a, IDispatcher _)
    {
        int attackCount = 0;
        int totalActions = 0;

        foreach (var entry in a.NewEntries)
        {
            if (entry.Action == "Attack")
            {
                await audio.PlayCombatAsync();
                attackCount++;
            }
            else if (entry.Action == "Forage")
            {
                await audio.PlayForageAsync();
            }
            totalActions++;
        }

        // Compute dynamic intensity based on attack ratio this turn
        if (totalActions > 0)
        {
            float combatRatio = (float)attackCount / totalActions;
            // Scale: 0 attacks = very low intensity, all attacks = high intensity
            float intensity = 0.05f + combatRatio * 0.9f;
            await audio.SetDynamicIntensityAsync(intensity);
        }

        // Check for victory/defeat fanfares
        if (a.Outcome is not null)
        {
            if (a.Outcome == "RedWin" || a.Outcome == "BlueWin")
            {
                await audio.PlayVictoryFanfareAsync();
            }
            else if (a.Outcome == "Draw")
            {
                await audio.PlayDefeatFanfareAsync();
            }

            // Stop ambient on session end
            await audio.StopAmbientAsync();
            await audio.StopHeartbeatAsync();
            _ambientStarted = false;
        }
    }

    [EffectMethod]
    public async Task Handle(ResetSimulationAction _, IDispatcher __)
    {
        if (_ambientStarted)
        {
            await audio.StopAmbientAsync();
            await audio.StopHeartbeatAsync();
            _ambientStarted = false;
        }
    }

    [EffectMethod]
    public async Task Handle(PostMortemReadyAction a, IDispatcher __)
    {
        // Play fanfare on post-mortem reveal
        if (a.WinnerName is not null)
            await audio.PlayVictoryFanfareAsync();
        else
            await audio.PlayDefeatFanfareAsync();
    }
}
