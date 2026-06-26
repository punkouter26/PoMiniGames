using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PoMiniGames.Features.PoFunQuiz;

namespace PoMiniGames.UnitTests.Features.PoFunQuiz;

/// <summary>
/// Unit tests for the PoFunQuiz in-memory multiplayer lobby. Uses the
/// <see cref="MockOpenAIService"/>-style static question generator indirectly through
/// <see cref="MultiplayerLobbyService"/> with a stub <see cref="IOpenAIService"/>.
/// </summary>
public sealed class MultiplayerLobbyServiceTests
{
    private sealed class StubAi : IOpenAIService
    {
        public Task<IReadOnlyList<QuizQuestion>> GenerateQuizQuestionsAsync(QuestionCategory category, int count, CancellationToken cancellationToken = default) =>
            Task.FromResult<IReadOnlyList<QuizQuestion>>(MockOpenAIService.GenerateQuestions(category, count));
    }

    private MultiplayerLobbyService NewLobby() => new(new StubAi(), NullLogger<MultiplayerLobbyService>.Instance);

    [Fact]
    public async Task Create_AssignsGameId_AndAddsHostAsPlayerOne()
    {
        var lobby = NewLobby();
        var game = await lobby.CreateAsync("conn1", "Alice", QuestionCategory.General, 5, default);
        game.GameId.Should().NotBeNullOrEmpty();
        game.HostConnectionId.Should().Be("conn1");
        game.Players.Should().ContainSingle(p => p.Name == "Alice" && p.PlayerNumber == 1);
        game.State.Should().Be(GameState.Waiting);
    }

    [Fact]
    public async Task Join_AddsSecondPlayer_AsPlayerNumberTwo()
    {
        var lobby = NewLobby();
        var game = await lobby.CreateAsync("conn1", "Alice", QuestionCategory.General, 5, default);
        var joined = lobby.Join(game.GameId, "conn2", "Bob");
        joined.Should().NotBeNull();
        joined!.Players.Should().HaveCount(2);
        joined.Players[1].Name.Should().Be("Bob");
        joined.Players[1].PlayerNumber.Should().Be(2);
    }

    [Fact]
    public void Join_UnknownGame_ReturnsNull()
    {
        var lobby = NewLobby();
        lobby.Join("ZZZZZZ", "conn2", "Bob").Should().BeNull();
    }

    [Fact]
    public async Task StartGame_RequiresHostAndTwoPlayers()
    {
        var lobby = NewLobby();
        var game = await lobby.CreateAsync("conn1", "Alice", QuestionCategory.General, 5, default);

        // Non-host cannot start
        lobby.Join(game.GameId, "conn2", "Bob");
        lobby.StartGame(game.GameId, "conn2").Should().BeFalse();

        // Host can start with two players
        lobby.StartGame(game.GameId, "conn1").Should().BeTrue();
        lobby.GetByConnection("conn1")!.State.Should().Be(GameState.InProgress);
    }

    [Fact]
    public async Task UpdateScore_CorrectAnswer_AddsBasePointsAndIncrementsStreak()
    {
        var lobby = NewLobby();
        var game = await lobby.CreateAsync("conn1", "Alice", QuestionCategory.General, 5, default);
        lobby.UpdateScore(game.GameId, "conn1", isCorrect: true, speedMultiplier: 1.0, secondsRemaining: 30);
        var player = lobby.GetByConnection("conn1")!.Players[0];
        player.ScoreState.BaseScore.Should().BeGreaterThan(0);
        player.CurrentStreak.Should().Be(1);
    }

    [Fact]
    public async Task UpdateScore_WrongAnswer_ResetsStreak()
    {
        var lobby = NewLobby();
        var game = await lobby.CreateAsync("conn1", "Alice", QuestionCategory.General, 5, default);
        lobby.UpdateScore(game.GameId, "conn1", isCorrect: true, 1.0, 30);
        lobby.UpdateScore(game.GameId, "conn1", isCorrect: false, 1.0, 0);
        lobby.GetByConnection("conn1")!.Players[0].CurrentStreak.Should().Be(0);
    }

    [Fact]
    public async Task RemovePlayer_PromotesNewHost()
    {
        var lobby = NewLobby();
        var game = await lobby.CreateAsync("conn1", "Alice", QuestionCategory.General, 5, default);
        lobby.Join(game.GameId, "conn2", "Bob");
        lobby.RemovePlayer("conn1", out _);
        var remaining = lobby.GetByConnection("conn2");
        remaining!.HostConnectionId.Should().Be("conn2");
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

    [Fact]
    public async Task Game_WinnerAndTieDetection()
    {
        var lobby = NewLobby();
        var game = await lobby.CreateAsync("conn1", "Alice", QuestionCategory.General, 5, default);
        lobby.Join(game.GameId, "conn2", "Bob");
        // Both players answer the same number of questions correctly → tie.
        lobby.UpdateScore(game.GameId, "conn1", isCorrect: true, 1.0, 30);
        lobby.UpdateScore(game.GameId, "conn2", isCorrect: true, 1.0, 30);
        var g = lobby.GetByConnection("conn1")!;
        g.IsTie.Should().BeTrue();
        g.Winner.Should().BeNull();
    }
}
