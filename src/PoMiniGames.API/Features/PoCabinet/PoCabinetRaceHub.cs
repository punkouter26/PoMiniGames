using Microsoft.AspNetCore.SignalR;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// SignalR hub for an in-progress PoCabinet race. Lives at
/// <c>/pocabinet/race-hub</c>. After the lobby hub hands off, every player in
/// the race group connects here, sends per-tick player intent (up/down/left/right),
/// and receives the 30 Hz <see cref="PoMiniGames.Shared.Games.PoCabinetRaceSnapshot"/>
/// back. Single in-process <see cref="PoCabinetRaceRegistry"/> drives the sim
/// and broadcasts; this hub is a thin layer between the WebSocket and the
/// registry.
/// </summary>
public sealed class PoCabinetRaceHub : Hub
{
    private readonly PoCabinetRaceRegistry _registry;

    public PoCabinetRaceHub(PoCabinetRaceRegistry registry) => _registry = registry;

    public Task JoinRace(string gameCode)
    {
        _registry.AttachConnection(gameCode, Context.ConnectionId);
        Groups.AddToGroupAsync(Context.ConnectionId, $"race:{gameCode}");
        return _registry.SendSnapshotAsync(gameCode, Context.ConnectionId);
    }

    public Task SubmitInput(string gameCode, PoCabinetInput input)
    {
        _registry.SubmitIntent(gameCode, Context.ConnectionId, input);
        return Task.CompletedTask;
    }

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        _registry.DetachConnection(Context.ConnectionId);
        return Task.CompletedTask;
    }
}