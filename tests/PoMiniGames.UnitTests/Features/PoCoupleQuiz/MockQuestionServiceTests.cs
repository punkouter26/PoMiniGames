using FluentAssertions;
using PoMiniGames.Features.PoCoupleQuiz;

namespace PoMiniGames.UnitTests.Features.PoCoupleQuiz;

/// <summary>
/// Sanity tests for the deterministic in-memory question service used when
/// <c>UseMockAi=true</c> (Dev/Test only — see the StartupSecretValidator pattern
/// from the 2026-06-13 mock-data fix).
/// </summary>
public sealed class MockQuestionServiceTests
{
    private readonly MockQuestionService _service = new();

    [Fact]
    public async Task GenerateQuestion_ReturnsNonEmptyText_ForEveryDifficulty()
    {
        foreach (var difficulty in new[] { DifficultyLevel.Easy, DifficultyLevel.Medium, DifficultyLevel.Hard })
        {
            var q = await _service.GenerateQuestionAsync(difficulty);
            q.Text.Should().NotBeNullOrWhiteSpace();
            q.Category.Should().BeDefined();
        }
    }

    [Fact]
    public async Task GenerateQuestion_RespectsExplicitCategory()
    {
        var q = await _service.GenerateQuestionAsync(DifficultyLevel.Medium, QuestionCategory.Hobbies);
        q.Category.Should().Be(QuestionCategory.Hobbies);
    }

    [Fact]
    public async Task CheckSimilarity_ReturnsOneForIdenticalAnswers()
    {
        var score = await _service.CheckAnswerSimilarityAsync("pizza", "pizza");
        score.Should().Be(1f);
    }

    [Fact]
    public async Task CheckSimilarity_IsCaseInsensitive()
    {
        var score = await _service.CheckAnswerSimilarityAsync("Pizza", "PIZZA");
        score.Should().Be(1f);
    }

    [Fact]
    public async Task CheckSimilarity_TrimsWhitespace()
    {
        var score = await _service.CheckAnswerSimilarityAsync("  pizza  ", "pizza");
        score.Should().Be(1f);
    }

    [Fact]
    public async Task CheckSimilarity_ReturnsZeroForDifferentAnswers()
    {
        var score = await _service.CheckAnswerSimilarityAsync("pizza", "sushi");
        score.Should().Be(0f);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public async Task CheckSimilarity_ReturnsZeroForEmptyInputs(string? input)
    {
        var score = await _service.CheckAnswerSimilarityAsync(input!, "anything");
        score.Should().Be(0f);
    }
}
