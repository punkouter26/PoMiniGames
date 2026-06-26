using FluentAssertions;
using PoMiniGames.Features.PoRunner;

namespace PoMiniGames.UnitTests;

/// <summary>
/// Drives the race-session state machine without a SignalR host. Possible only after broadcast
/// moved behind <see cref="IGameBroadcaster"/> — the manager now takes a fake broadcaster instead
/// of reaching into <c>IHubContext</c>, so join → ready → countdown → finish → restart is assertable.
/// </summary>
public class GameSessionManagerTests
{
    private sealed class FakeBroadcaster : IGameBroadcaster
    {
        public Task BroadcastRoomStateAsync(GameRoom room) => Task.CompletedTask;
        public Task BroadcastGameOverAsync(GameRoom room, string? winnerId, bool timedOut, bool qualifiesForHighScore) => Task.CompletedTask;
    }

    private static GameSessionManager NewManager() =>
        new(new FakeBroadcaster(), logger: null, options: null, gracePeriod: TimeSpan.Zero);

    [Fact]
    public void SecondPlayerJoining_MovesRoomToReadyCheck()
    {
        var mgr = NewManager();

        var (room1, isNew1) = mgr.AddPlayer("conn-1");
        room1.Status.Should().Be(GameStatus.Waiting);
        isNew1.Should().BeTrue();

        var (room2, isNew2) = mgr.AddPlayer("conn-2");
        isNew2.Should().BeFalse();
        room2.RoomId.Should().Be(room1.RoomId);
        room2.Status.Should().Be(GameStatus.ReadyCheck);
        room2.Players.Should().HaveCount(2);
    }

    [Fact]
    public void AllPlayersReady_ThenCountdown_ThenFinish_ThenRestart()
    {
        var mgr = NewManager();
        var (room, _) = mgr.AddPlayer("conn-1");
        mgr.AddPlayer("conn-2");

        mgr.SetPlayerReady("conn-1").Should().BeTrue();
        mgr.SetPlayerReady("conn-2").Should().BeTrue();
        mgr.AllPlayersReady(room.RoomId).Should().BeTrue();

        mgr.StartCountdown(room.RoomId);
        room.Status.Should().Be(GameStatus.Countdown);

        mgr.FinishRace("conn-1");
        room.Status.Should().Be(GameStatus.GameOver);
        room.FinishedPlayerId.Should().Be("conn-1");

        mgr.RequestRestart("conn-1").Should().BeTrue();
        room.Status.Should().Be(GameStatus.ReadyCheck);
        room.HighScoreSubmitted.Should().BeFalse();
    }

    [Fact]
    public void RemovingLastPlayer_DropsTheRoom()
    {
        var mgr = NewManager();
        var (room, _) = mgr.AddPlayer("conn-solo");

        mgr.RemovePlayer("conn-solo");

        mgr.GetRoomForPlayer("conn-solo").Should().BeNull();
    }

    [Fact]
    public void FinishRace_IsIdempotent_FirstFinisherWins()
    {
        var mgr = NewManager();
        var (room, _) = mgr.AddPlayer("conn-1");
        mgr.AddPlayer("conn-2");
        mgr.SetPlayerReady("conn-1");
        mgr.SetPlayerReady("conn-2");
        mgr.StartCountdown(room.RoomId);

        mgr.FinishRace("conn-1");
        mgr.FinishRace("conn-2");

        room.FinishedPlayerId.Should().Be("conn-1");
    }
}
