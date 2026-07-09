namespace PoMiniGamesClient.Games.PoSurvive.Services;

using Fluxor;
using PoMiniGamesClient.Games.PoSurvive.Store;

/// <summary>Fluxor effects that feed HeartbeatEventDtos into SessionLogService (T070).</summary>
public sealed class SessionLogEffects(SessionLogService log)
{
    [EffectMethod]
    public async Task Handle(SimulationInitialisedAction a, IDispatcher _)
        => await log.OpenSessionAsync(a.SessionId);

    [EffectMethod]
    public async Task Handle(HeartbeatCompletedAction a, IDispatcher _)
    {
        foreach (var evt in a.HeartbeatEvents)
            await log.AppendAsync(evt);
    }
}
