using FluentAssertions;
using PoMiniGames.Features.PoCoupleQuiz;

namespace PoMiniGames.UnitTests.Features.PoCoupleQuiz;

/// <summary>
/// Unit tests for the in-memory game session manager — the authoritative
/// state holder for PoCoupleQuiz lobbies (sessions do NOT survive restarts).
/// </summary>
public sealed class GameSessionManagerTests
{
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

    [Fact]
    public void JoinLobby_AppendsPlayer()
    {
        var mgr = new GameSessionManager();
        var s = mgr.CreateLobby("conn1", "Alice", DifficultyLevel.Medium);
        var joined = mgr.JoinLobby(s.GameCode, "conn2", "Bob");
        joined.Should().NotBeNull();
        joined!.Players.Should().HaveCount(2);
    }

    [Fact]
    public void JoinLobby_ReturnsNullForUnknownCode()
    {
        var mgr = new GameSessionManager();
        mgr.JoinLobby("ZZZZZ", "conn2", "Bob").Should().BeNull();
    }

    [Fact]
    public void JoinOrCreate_ReusesWaitingLobby()
    {
        var mgr = new GameSessionManager();
        var first = mgr.CreateLobby("conn1", "Alice", DifficultyLevel.Medium);
        var (second, created) = (mgr.JoinOrCreateLobby("conn2", "Bob", DifficultyLevel.Medium, out var c), c);
        created.Should().BeFalse();
        second.GameCode.Should().Be(first.GameCode);
        second.Players.Should().HaveCount(2);
    }

    [Fact]
    public void JoinOrCreate_CreatesNewWhenNoWaitingLobby()
    {
        var mgr = new GameSessionManager();
        var (s, created) = (mgr.JoinOrCreateLobby("conn1", "Alice", DifficultyLevel.Medium, out var c), c);
        created.Should().BeTrue();
        s.Players.Should().ContainSingle();
    }

    [Fact]
    public void RemovePlayer_PromotesNewHostWhenHostLeaves()
    {
        var mgr = new GameSessionManager();
        var s = mgr.CreateLobby("conn1", "Alice", DifficultyLevel.Medium);
        mgr.JoinLobby(s.GameCode, "conn2", "Bob");
        mgr.RemovePlayer("conn1", out _);
        var remaining = mgr.GetSession(s.GameCode);
        remaining!.HostConnectionId.Should().Be("conn2");
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
    public void RecordAnswer_RecordsNonKingAnswer()
    {
        var mgr = new GameSessionManager();
        var s = mgr.CreateLobby("conn1", "Alice", DifficultyLevel.Easy);
        mgr.JoinLobby(s.GameCode, "conn2", "Bob");
        mgr.StartGame(s.GameCode, "Q?", "Hobbies");
        var ok = mgr.RecordAnswer(s.GameCode, "Bob", "pizza");
        ok.Should().BeTrue();
        mgr.GetSession(s.GameCode)!.CurrentQuestion!.PlayerAnswers.Should().ContainKey("Bob");
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

    [Fact]
    public void UpdateLobbyAiMode_OnlyHostCanChange()
    {
        var mgr = new GameSessionManager();
        var s = mgr.CreateLobby("conn1", "Alice", DifficultyLevel.Medium, aiMode: "Remote");
        mgr.JoinLobby(s.GameCode, "conn2", "Bob");
        mgr.UpdateLobbyAiMode(s.GameCode, "conn2", "Browser").Should().BeNull("non-hosts cannot change AI mode");
        var updated = mgr.UpdateLobbyAiMode(s.GameCode, "conn1", "Browser");
        updated.Should().NotBeNull();
        updated!.AiMode.Should().Be("Browser");
    }

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

    [Fact]
    public void Game_MaxRounds_MapsDifficulty()
    {
        new Game { Difficulty = DifficultyLevel.Easy }.MaxRounds.Should().Be(3);
        new Game { Difficulty = DifficultyLevel.Medium }.MaxRounds.Should().Be(5);
        new Game { Difficulty = DifficultyLevel.Hard }.MaxRounds.Should().Be(7);
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
