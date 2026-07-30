namespace PoMiniGamesClient.Games.PoSurvive.Services;

using PoMiniGamesClient.Games.PoSurvive.Store;

/// <summary>
/// Turns simulation events into audio: ambient drone lifecycle, heartbeat intensity
/// scaled by combat activity, and victory/defeat fanfares.
///
/// Was AudioEffects — a set of [EffectMethod] handlers Fluxor discovered by convention.
/// The methods are the same; SurviveStore now calls them directly.
/// </summary>
public sealed class AudioCues(AudioService audio)
{
    private bool _ambientStarted;

    public async Task OnInitialisedAsync()
    {
        await audio.StartAmbientAsync();
        await audio.StartHeartbeatAsync(intensity: 0.05f);
        _ambientStarted = true;
    }

    public Task OnAgentDiedAsync() => audio.PlayDeathAsync();

    public async Task OnHeartbeatAsync(IReadOnlyList<ConsoleEntry> newEntries, string? outcome)
    {
        int attackCount = 0;
        int totalActions = 0;

        foreach (var entry in newEntries)
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

        // Scale: 0 attacks = very low intensity, all attacks = high intensity.
        if (totalActions > 0)
        {
            float combatRatio = (float)attackCount / totalActions;
            await audio.SetDynamicIntensityAsync(0.05f + combatRatio * 0.9f);
        }

        // The fanfare belongs to OnPostMortemAsync, which the orchestrator calls immediately
        // after this heartbeat on the deciding turn. Playing it here too meant every match
        // ended with two overlapping fanfares. This hook only quiets the ambient bed.
        if (outcome is not null)
            await StopAmbientAsync();
    }

    public async Task OnResetAsync()
    {
        if (_ambientStarted)
            await StopAmbientAsync();
    }

    public async Task OnPostMortemAsync(bool hasWinner)
    {
        if (hasWinner)
            await audio.PlayVictoryFanfareAsync();
        else
            await audio.PlayDefeatFanfareAsync();
    }

    private async Task StopAmbientAsync()
    {
        await audio.StopAmbientAsync();
        await audio.StopHeartbeatAsync();
        _ambientStarted = false;
    }
}
