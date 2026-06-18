using Microsoft.AspNetCore.SignalR;

namespace PoMiniGames.Features.PoRunner;

/// <summary>
/// The seam between the race-session state machine and the transport that ships state to
/// clients. The session module decides <em>what</em> changed; an adapter decides <em>how</em>
/// it reaches players. In production the adapter is SignalR; in tests it is an in-memory fake,
/// letting the countdown/finish/timeout logic be exercised without a live hub.
/// </summary>
/// <remarks>
/// Pattern: Ports &amp; Adapters. Lifting broadcast behind this port keeps SignalR from leaking
/// across the session module's interface, concentrating race rules in one testable place.
/// </remarks>
public interface IGameBroadcaster
{
    /// <summary>Pushes the current room state ("gameState") to everyone in the room.</summary>
    Task BroadcastRoomStateAsync(GameRoom room);

    /// <summary>Pushes a terminal "gameOver" event to everyone in the room.</summary>
    Task BroadcastGameOverAsync(GameRoom room, string? winnerId, bool timedOut, bool qualifiesForHighScore);
}

/// <summary>SignalR adapter for <see cref="IGameBroadcaster"/> — the production transport.</summary>
public sealed class SignalRGameBroadcaster : IGameBroadcaster
{
    private readonly IHubContext<GameHub> _hubContext;

    public SignalRGameBroadcaster(IHubContext<GameHub> hubContext) => _hubContext = hubContext;

    public Task BroadcastRoomStateAsync(GameRoom room) =>
        _hubContext.Clients.Group(room.RoomId).SendAsync("gameState", new
        {
            players = room.Players,
            status = room.Status.ToString().ToLowerInvariant(),
            countdownStartTimeMs = room.CountdownStartTimeMs,
            raceStartTimeMs = room.RaceStartTimeMs,
            finishedPlayerId = room.FinishedPlayerId,
        });

    public Task BroadcastGameOverAsync(GameRoom room, string? winnerId, bool timedOut, bool qualifiesForHighScore) =>
        _hubContext.Clients.Group(room.RoomId).SendAsync("gameOver", new
        {
            winnerId,
            timeMs = room.FinishTimeMs,
            players = room.Players,
            qualifiesForHighScore,
            timedOut,
        });
}
