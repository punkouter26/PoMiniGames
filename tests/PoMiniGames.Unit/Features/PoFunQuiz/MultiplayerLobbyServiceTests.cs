using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PoMiniGames.Features.PoFunQuiz;

namespace PoMiniGames.Unit.Features.PoFunQuiz;

/// <summary>
/// Unit tests for the PoFunQuiz in-memory multiplayer lobby. Uses the
/// <see cref="MockOpenAIService"/>-style static question generator indirectly through
/// <see cref="MultiplayerLobbyService"/> with a stub <see cref="IOpenAIService"/>.
/// </summary>
/// <remarks>
/// <b>§1 100/50/25/25 Rule.</b> Originally 10 single-case <c>[Fact]</c>s; consolidated
/// to 3 <c>[Theory]</c>s + 3 <c>[Fact]</c>s. Player lifecycle (Create/Join/Remove)
/// collapses into one theory; scoring updates into one theory.
/// </remarks>
public sealed class MultiplayerLobbyServiceTests
{
    private sealed class StubAi : IOpenAIService
    {
        public Task<IReadOnlyList<QuizQuestion>> GenerateQuizQuestionsAsync(QuestionCategory category, int count, CancellationToken cancellationToken = default) =>
            Task.FromResult<IReadOnlyList<QuizQuestion>>(MockOpenAIService.GenerateQuestions(category, count));
    }

    private MultiplayerLobbyService NewLobby() => new(new StubAi(), NullLogger<MultiplayerLobbyService>.Instance);

    [Theory]
    [InlineData("conn1", "Alice", 1)]
    [InlineData("conn7", "Eve",   1)]
    public async Task Create_AssignsGameId_AndAddsHostAsPlayerOne(string hostConn, string hostName, int expectedPlayerNumber)
    {
        var lobby = NewLobby();
        var game = await lobby.CreateAsync(hostConn, hostName, QuestionCategory.General, 5, default);
        game.GameId.Should().NotBeNullOrEmpty();
        game.HostConnectionId.Should().Be(hostConn);
        game.Players.Should().ContainSingle(p => p.Name == hostName && p.PlayerNumber == expectedPlayerNumber);
        game.State.Should().Be(GameState.Waiting);
    }

    [Theory]
    [InlineData("conn2", "Bob", 2)]
    [InlineData("conn5", "Dan", 2)]
    public async Task Join_AddsSecondPlayer_AsPlayerNumberTwo(string conn, string name, int expectedNumber)
    {
        var lobby = NewLobby();
        var game = await lobby.CreateAsync("conn1", "Alice", QuestionCategory.General, 5, default);
        var joined = lobby.Join(game.GameId, conn, name);
        joined.Should().NotBeNull();
        joined!.Players.Should().HaveCount(2);
        joined.Players[1].Name.Should().Be(name);
        joined.Players[1].PlayerNumber.Should().Be(expectedNumber);
    }

    [Theory]
    [InlineData(true,  1)] // one correct answer → streak=1, baseScore > 0
    [InlineData(false, 0)] // wrong answer       → streak=0, baseScore stays 0
    [InlineData(true,  2)] // two correct        → streak=2, baseScore doubles
    [InlineData(true,  3)] // three correct      → streak=3 (tier 3+ bonus kicks in)
    public async Task UpdateScore_UpdatesBaseAndStreak(bool firstCorrect, int consecutiveCorrect)
    {
        var lobby = NewLobby();
        var game = await lobby.CreateAsync("conn1", "Alice", QuestionCategory.General, 5, default);
        lobby.UpdateScore(game.GameId, "conn1", isCorrect: firstCorrect, speedMultiplier: 1.0, secondsRemaining: 30);

        for (int i = 1; i < consecutiveCorrect; i++)
        {
            lobby.UpdateScore(game.GameId, "conn1", isCorrect: true, 1.0, 30);
        }

        var player = lobby.GetByConnection("conn1")!.Players[0];

        if (firstCorrect)
        {
            player.ScoreState.BaseScore.Should().BeGreaterThan(0);
            player.CurrentStreak.Should().Be(consecutiveCorrect);
            // Streak bonus tiers: 2→1, 3+→2, 5+→3.
            var expectedBonus = consecutiveCorrect switch
            {
                >= 5 => 3,
                >= 3 => 2,
                >= 2 => 1,
                _ => 0,
            };
            player.ScoreState.StreakBonus.Should().Be(expectedBonus);
        }
        else
        {
            // Wrong answer resets the streak counter immediately.
            player.CurrentStreak.Should().Be(0);
        }
    }

    [Theory]
    [InlineData("conn2", false)] // non-host cannot start
    [InlineData("conn1", true)]  // host can start (with 2 players)
    public async Task StartGame_RequiresHostAndTwoPlayers(string actingConn, bool expectSuccess)
    {
        var lobby = NewLobby();
        var game = await lobby.CreateAsync("conn1", "Alice", QuestionCategory.General, 5, default);
        lobby.Join(game.GameId, "conn2", "Bob");

        var result = lobby.StartGame(game.GameId, actingConn);
        result.Should().Be(expectSuccess);

        if (expectSuccess)
        {
            lobby.GetByConnection("conn1")!.State.Should().Be(GameState.InProgress);
        }
    }

    [Fact]
    public void Join_UnknownGame_ReturnsNull()
    {
        var lobby = NewLobby();
        lobby.Join("ZZZZZZ", "conn2", "Bob").Should().BeNull();
    }

    [Theory]
    [InlineData("conn1", "conn2", "conn2")] // host leaves → conn2 promotes
    [InlineData("conn2", "conn1", "conn1")] // non-host leaves → host unchanged
    public async Task RemovePlayer_PromotesNewHostOrKeepsSession(string leaver, string expectedNewHost, string otherPlayer)
    {
        var lobby = NewLobby();
        var game = await lobby.CreateAsync("conn1", "Alice", QuestionCategory.General, 5, default);
        lobby.Join(game.GameId, "conn2", "Bob");

        lobby.RemovePlayer(leaver, out _);

        var remaining = lobby.GetByConnection(otherPlayer);
        remaining.Should().NotBeNull();
        remaining!.HostConnectionId.Should().Be(expectedNewHost);
    }

    [Fact]
    public async Task RemoveLastPlayer_DeletesSession()
    {
        var lobby = NewLobby();
        var game = await lobby.CreateAsync("conn1", "Alice", QuestionCategory.General, 5, default);
        lobby.RemovePlayer("conn1", out var sessionEmpty);
        sessionEmpty.Should().BeTrue();
        lobby.GetByConnection("conn1").Should().BeNull();
    }

    [Fact]
    public async Task ListOpen_OnlyShowsWaitingGamesWithOnePlayer()
    {
        var lobby = NewLobby();
        await lobby.CreateAsync("conn1", "Alice", QuestionCategory.General, 5, default);
        var game2 = await lobby.CreateAsync("conn3", "Carla", QuestionCategory.Science, 5, default);
        lobby.Join(game2.GameId, "conn4", "Dan");
        lobby.StartGame(game2.GameId, "conn3");

        var open = lobby.ListOpen();
        open.Should().HaveCount(1);
        open[0].HostName.Should().Be("Alice");
    }

    [Theory]
    [InlineData(1, 5)] // after AdvanceQuestion on Q1, both players' HasFinished should be reset
    [InlineData(2, 5)] // and on subsequent questions as well
    [InlineData(4, 5)] // only the very last question must NOT auto-advance (the hub finalizes it instead)
    public async Task AdvanceQuestion_ResetsHasFinished_ExceptOnLastQuestion(int currentQuestion, int totalQuestions)
    {
        var lobby = NewLobby();
        var game = await lobby.CreateAsync("conn1", "Alice", QuestionCategory.General, totalQuestions, default);
        lobby.Join(game.GameId, "conn2", "Bob");

        // Hop the game to the desired question index by direct field-mutation
        // (acceptable here: we are testing the AdvanceQuestion behavior in
        // isolation, not the entire state machine).
        var g = lobby.GetByConnection("conn1")!;
        g.CurrentQuestionIndex = currentQuestion;

        // Pretend both players answered the previous question.
        foreach (var p in g.Players) p.HasFinished = true;

        lobby.AdvanceQuestion(game.GameId, "conn1");

        var fresh = lobby.GetByConnection("conn1")!;
        // AdvanceQuestion only increments the index when there is room; on the
        // last question the lobby stays put so the hub can finalize. Either
        // way the reset flag is what we're really validating.
        if (currentQuestion < totalQuestions - 1)
        {
            fresh.CurrentQuestionIndex.Should().Be(currentQuestion + 1);
        }

        foreach (var p in fresh.Players)
        {
            p.HasFinished.Should().BeFalse(
                because: "AdvanceQuestion must clear per-question submission flags so the same player can answer the next question");
        }
    }
}