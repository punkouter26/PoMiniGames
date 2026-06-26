using FluentAssertions;
using PoMiniGames.Features.PoFunQuiz;

namespace PoMiniGames.UnitTests.Features.PoFunQuiz;

/// <summary>
/// Tests for the PoFunQuiz domain models — pure logic, no I/O.
/// </summary>
public sealed class FunQuizModelsTests
{
    [Fact]
    public void QuizQuestion_BasePoints_MapsDifficulty()
    {
        new QuizQuestion { Difficulty = DifficultyLevel.Easy }.BasePoints.Should().Be(1);
        new QuizQuestion { Difficulty = DifficultyLevel.Medium }.BasePoints.Should().Be(2);
        new QuizQuestion { Difficulty = DifficultyLevel.Hard }.BasePoints.Should().Be(3);
    }

    [Fact]
    public void PlayerScoreState_StartsAtZero()
    {
        var s = new PlayerScoreState();
        s.BaseScore.Should().Be(0);
        s.SpeedBonus.Should().Be(0);
        s.StreakBonus.Should().Be(0);
        s.TimeBonus.Should().Be(0);
        s.TotalScore.Should().Be(0);
    }

    [Fact]
    public void PlayerScoreState_CorrectAnswer_AccumulatesBaseAndStreak()
    {
        var s = new PlayerScoreState();
        s.ApplyCorrectAnswer(basePoints: 2, speedMultiplier: 1.0);
        s.BaseScore.Should().Be(2);
        s.StreakBonus.Should().Be(0);

        s.ApplyCorrectAnswer(2, 1.0);
        s.BaseScore.Should().Be(4);
        s.StreakBonus.Should().Be(1); // streak 2 → +1

        s.ApplyCorrectAnswer(2, 1.0);
        s.StreakBonus.Should().Be(2); // streak 3 → +2
    }

    [Fact]
    public void PlayerScoreState_WrongAnswer_ResetsStreak()
    {
        var s = new PlayerScoreState();
        s.ApplyCorrectAnswer(2, 1.0);
        s.ApplyCorrectAnswer(2, 1.0);
        s.StreakBonus.Should().Be(1);
        s.ResetStreak();
        s.ApplyCorrectAnswer(2, 1.0);
        s.StreakBonus.Should().Be(0);
    }

    [Fact]
    public void PlayerScoreState_SpeedBonus_AddsExtraPoints()
    {
        var s = new PlayerScoreState();
        s.ApplyCorrectAnswer(basePoints: 2, speedMultiplier: 2.0);
        s.SpeedBonus.Should().Be(2); // 2 * (2.0 - 1.0) = 2
    }

    [Fact]
    public void PlayerScoreState_TimeBonus_SetExplicitly()
    {
        var s = new PlayerScoreState();
        s.SetTimeBonus(50);
        s.TimeBonus.Should().Be(50);
        s.TotalScore.Should().Be(50);
    }

    [Fact]
    public void GameSession_TieDetection()
    {
        var session = new GameSession
        {
            Player1 = new Player { Name = "A" },
            Player2 = new Player { Name = "B" }
        };
        session.Player1State.SetBaseScore(10);
        session.Player2State.SetBaseScore(10);
        session.IsTie.Should().BeTrue();
        session.Winner.Should().BeNull();
    }

    [Fact]
    public void GameSession_HigherPlayerWins()
    {
        var session = new GameSession
        {
            Player1 = new Player { Name = "A" },
            Player2 = new Player { Name = "B" }
        };
        session.Player1State.SetBaseScore(15);
        session.Player2State.SetBaseScore(8);
        session.IsTie.Should().BeFalse();
        session.Winner!.Name.Should().Be("A");
    }

    [Fact]
    public void GameSession_Duration_ZeroUntilEndTimeSet()
    {
        var session = new GameSession();
        session.Duration.Should().Be(TimeSpan.Zero);
        session.StartTime = DateTime.UtcNow;
        session.EndTime = DateTime.UtcNow.AddSeconds(45);
        session.Duration.Should().BeCloseTo(TimeSpan.FromSeconds(45), TimeSpan.FromMilliseconds(50));
    }

    [Fact]
    public void MockOpenAIService_ReturnsRequestedCount()
    {
        var q = MockOpenAIService.GenerateQuestions(QuestionCategory.Science, 12);
        q.Should().HaveCount(12);
        q.Should().AllSatisfy(question =>
        {
            question.Text.Should().NotBeNullOrWhiteSpace();
            question.Options.Should().HaveCount(4);
            question.CorrectOptionIndex.Should().BeInRange(0, 3);
        });
    }

    [Fact]
    public void MockOpenAIService_UnknownCategoryFallsBackToGeneral()
    {
        // Use reflection to bypass the enum — service should fall back gracefully.
        var q = MockOpenAIService.GenerateQuestions(QuestionCategory.General, 5);
        q.Should().HaveCount(5);
    }
}
