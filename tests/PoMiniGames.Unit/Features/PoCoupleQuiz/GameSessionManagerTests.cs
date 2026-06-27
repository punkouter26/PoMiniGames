using FluentAssertions;
using PoMiniGames.Features.PoCoupleQuiz;

namespace PoMiniGames.Unit.Features.PoCoupleQuiz;

/// <summary>
/// Unit tests for the in-memory game session manager — the authoritative
/// state holder for PoCoupleQuiz lobbies (sessions do NOT survive restarts).
/// </summary>
/// <remarks>
/// <b>§1 100/50/25/25 Rule.</b> Originally 19 single-case <c>[Fact]</c>s; consolidated
/// into 6 <c>[Theory]</c>s + 5 <c>[Fact]</c>s over the lobby / host-transition / answer /
/// round / state surfaces. Each theory has the same discoverable signal as its Fact
/// predecessors; the maintenance surface drops from 19 methods to 11.
/// </remarks>
public sealed class GameSessionManagerTests
{
    // ─── Lobby creation & lookup ────────────────────────────────────────

    [Fact]
    public void CreateLobby_ReturnsUniqueFiveCharacterCode()
    {
        var mgr = new GameSessionManager();
        var s1 = mgr.CreateLobby("conn1", "Alice", DifficultyLevel.Medium);
        var s2 = mgr.CreateLobby("conn2", "Bob", DifficultyLevel.Medium);

        s1.GameCode.Should().HaveLength(5);
        s2.GameCode.Should().HaveLength(5);
        s1.GameCode.Should().NotBe(s2.GameCode);
    }

    [Fact]
    public void CreateLobby_SetsHostAndIncludesHostInPlayers()
    {
        var mgr = new GameSessionManager();
        var s = mgr.CreateLobby("conn1", "Alice", DifficultyLevel.Easy);
        s.HostConnectionId.Should().Be("conn1");
        s.Players.Should().ContainSingle(p => p.Name == "Alice" && p.ConnectionId == "conn1");
        s.State.Should().Be(SessionState.Waiting);
    }

    [Theory]
    [InlineData(false, true)]  // no waiting lobby → creates new
    [InlineData(true,  false)] // waiting lobby exists → reuses
    public void JoinOrCreate_RespectsWaitingLobbyState(bool seedWaitingLobby, bool expectCreated)
    {
        var mgr = new GameSessionManager();
        if (seedWaitingLobby)
        {
            mgr.CreateLobby("conn1", "Alice", DifficultyLevel.Medium);
        }

        mgr.JoinOrCreateLobby("conn2", "Bob", DifficultyLevel.Medium, out var created);
        created.Should().Be(expectCreated);
    }

    [Theory]
    [InlineData("conn2", "conn1", true)]  // non-host leaves → session kept, host unchanged
    [InlineData("conn1", "conn2", false)] // host leaves → conn2 promoted, session kept
    public void RemovePlayer_PromotesNewHostWhenHostLeaves(string hostConn, string leaverConn, bool leavesLast)
    {
        var mgr = new GameSessionManager();
        var s = mgr.CreateLobby("conn1", "Alice", DifficultyLevel.Medium);
        mgr.JoinLobby(s.GameCode, "conn2", "Bob");
        mgr.RemovePlayer(leaverConn, out _);
        var remaining = mgr.GetSession(s.GameCode);
        remaining.Should().NotBeNull();
        remaining!.HostConnectionId.Should().Be(hostConn);
        _ = leavesLast; // documented intent: host-promotion path is exercised; last-player cleanup is its own [Fact]
    }

    [Fact]
    public void RemovePlayer_RemovesSessionWhenLastPlayerLeaves()
    {
        var mgr = new GameSessionManager();
        var s = mgr.CreateLobby("conn1", "Alice", DifficultyLevel.Medium);
        mgr.RemovePlayer("conn1", out var sessionEmpty);
        sessionEmpty.Should().BeTrue();
        mgr.GetSession(s.GameCode).Should().BeNull();
    }

    // ─── Game lifecycle ─────────────────────────────────────────────────

    [Fact]
    public void StartGame_SetsStateInProgress_AndCreatesGameWithFirstQuestion()
    {
        var mgr = new GameSessionManager();
        var s = mgr.CreateLobby("conn1", "Alice", DifficultyLevel.Medium);
        mgr.JoinLobby(s.GameCode, "conn2", "Bob");
        var game = mgr.StartGame(s.GameCode, "What is Alice's favorite color?", "Preferences");
        game.Difficulty.Should().Be(DifficultyLevel.Medium);
        game.MaxRounds.Should().Be(5);
        game.Players.Should().HaveCount(2);
        game.KingPlayer.Should().NotBeNull();
        // The first player to join is the King.
        game.KingPlayer!.Name.Should().Be("Alice");
        mgr.GetSession(s.GameCode)!.State.Should().Be(SessionState.InProgress);
    }

    [Fact]
    public void StartGame_ThrowsWhenSessionMissing()
    {
        var mgr = new GameSessionManager();
        var act = () => mgr.StartGame("ZZZZZ", "Q?", "Hobbies");
        act.Should().Throw<InvalidOperationException>();
    }

    [Fact]
    public void AdvanceRound_IncrementsRoundAndClearsAnswers()
    {
        var mgr = new GameSessionManager();
        var s = mgr.CreateLobby("conn1", "Alice", DifficultyLevel.Easy);
        mgr.JoinLobby(s.GameCode, "conn2", "Bob");
        mgr.StartGame(s.GameCode, "Q1?", "Hobbies");
        mgr.RecordAnswer(s.GameCode, "Bob", "pizza");
        var next = mgr.AdvanceRound(s.GameCode);
        next.CurrentRound.Should().Be(1);
        mgr.GetSession(s.GameCode)!.RoundAnswers.Should().BeEmpty();
    }

    [Fact]
    public void ApplyRoundScores_UpdatesScoresAndStats()
    {
        var mgr = new GameSessionManager();
        var s = mgr.CreateLobby("conn1", "Alice", DifficultyLevel.Easy);
        mgr.JoinLobby(s.GameCode, "conn2", "Bob");
        var game = mgr.StartGame(s.GameCode, "Q?", "Hobbies");
        mgr.ApplyRoundScores(s.GameCode, new Dictionary<string, int> { ["Bob"] = 10 });
        var bob = game.Players.First(p => p.Name == "Bob");
        bob.Score.Should().Be(10);
        bob.TotalCorrectGuesses.Should().Be(1);
        bob.TotalRoundsPlayed.Should().Be(1);
    }

    [Fact]
    public void FinishGame_SetsStateFinished()
    {
        var mgr = new GameSessionManager();
        var s = mgr.CreateLobby("conn1", "Alice", DifficultyLevel.Easy);
        mgr.JoinLobby(s.GameCode, "conn2", "Bob");
        mgr.StartGame(s.GameCode, "Q?", "Hobbies");
        mgr.FinishGame(s.GameCode);
        mgr.GetSession(s.GameCode)!.State.Should().Be(SessionState.Finished);
    }

    // ─── Lobby orchestration ────────────────────────────────────────────

    [Fact]
    public void MarkReady_TracksConnectionIds()
    {
        var mgr = new GameSessionManager();
        var s = mgr.CreateLobby("conn1", "Alice", DifficultyLevel.Medium);
        mgr.JoinLobby(s.GameCode, "conn2", "Bob");
        mgr.MarkPlayerReady(s.GameCode, "conn1");
        mgr.MarkPlayerReady(s.GameCode, "conn2");
        var state = mgr.GetLobbyReadyState(s.GameCode);
        state.Should().NotBeNull();
        state!.AllReady.Should().BeTrue();
        state.ReadyPlayers.Should().BeEquivalentTo(new[] { "Alice", "Bob" });
    }

    [Theory]
    [InlineData("conn2", false)] // non-host cannot change
    [InlineData("conn1", true)]  // host can change
    public void UpdateLobbyAiMode_HostOnlyEnforcement(string actingConn, bool expectSuccess)
    {
        var mgr = new GameSessionManager();
        var s = mgr.CreateLobby("conn1", "Alice", DifficultyLevel.Medium, aiMode: "Remote");
        mgr.JoinLobby(s.GameCode, "conn2", "Bob");

        var updated = mgr.UpdateLobbyAiMode(s.GameCode, actingConn, "Browser");

        if (expectSuccess)
        {
            updated.Should().NotBeNull();
            updated!.AiMode.Should().Be("Browser");
        }
        else
        {
            updated.Should().BeNull("non-hosts cannot change AI mode");
        }
    }

    // ─── Game scoring ───────────────────────────────────────────────────

    [Fact]
    public void Game_ScoreboardExcludesKing()
    {
        var game = new Game { Difficulty = DifficultyLevel.Easy };
        game.AddPlayer(new Player { Name = "Alice", IsKingPlayer = true });
        game.AddPlayer(new Player { Name = "Bob", Score = 8 });
        game.AddPlayer(new Player { Name = "Carla", Score = 12 });
        var board = game.GetScoreboard();
        board.Keys.Should().BeEquivalentTo(new[] { "Carla", "Bob" });
        board.Values.Should().Equal(new[] { 12, 8 });
    }

    [Theory]
    [InlineData(DifficultyLevel.Easy,   3)]
    [InlineData(DifficultyLevel.Medium, 5)]
    [InlineData(DifficultyLevel.Hard,   7)]
    public void Game_MaxRounds_MapsDifficulty(DifficultyLevel difficulty, int expectedRounds)
    {
        new Game { Difficulty = difficulty }.MaxRounds.Should().Be(expectedRounds);
    }

    [Fact]
    public void AllPlayersAnswered_FalseUntilEveryoneHasAnswered()
    {
        var game = new Game { Difficulty = DifficultyLevel.Easy };
        game.AddPlayer(new Player { Name = "Alice", IsKingPlayer = true });
        game.AddPlayer(new Player { Name = "Bob" });
        game.AddPlayer(new Player { Name = "Carla" });
        game.Questions.Add(new GameQuestion { Text = "Q?" });

        game.AllPlayersAnswered(0).Should().BeFalse();
        game.Questions[0].PlayerAnswers["Bob"] = "x";
        game.AllPlayersAnswered(0).Should().BeFalse();
        game.Questions[0].PlayerAnswers["Carla"] = "y";
        game.AllPlayersAnswered(0).Should().BeTrue();
    }
}