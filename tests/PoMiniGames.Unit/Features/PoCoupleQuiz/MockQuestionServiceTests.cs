using FluentAssertions;
using PoMiniGames.Features.PoCoupleQuiz;

namespace PoMiniGames.Unit.Features.PoCoupleQuiz;

/// <summary>
/// Sanity tests for the deterministic in-memory question service used when
/// <c>UseMockAi=true</c> (Dev/Test only — see the StartupSecretValidator pattern
/// from the 2026-06-13 mock-data fix).
/// </summary>
/// <remarks>
/// <b>§1 100/50/25/25 Rule.</b> Originally 7 single-case <c>[Fact]</c>s + 1
/// <c>[Theory]</c>; consolidated to 2 <c>[Theory]</c>s + 1 <c>[Fact]</c>. The
/// CheckSimilarity facts collapse into one theory parameterized over (a, b, expected).
/// The difficulty theory became a single fact when DifficultyLevel was removed.
/// </remarks>
public sealed class MockQuestionServiceTests
{
    private readonly MockQuestionService _service = new();

    [Fact]
    public async Task GenerateQuestion_ReturnsNonEmptyText()
    {
        // Was a [Theory] over DifficultyLevel. That enum is gone: it was surfaced to
        // players as "Difficulty" but only ever chose the round count.
        var q = await _service.GenerateQuestionAsync();
        q.Text.Should().NotBeNullOrWhiteSpace();
        q.Category.Should().BeDefined();
    }

    [Theory]
    [InlineData("pizza", "pizza", 1f)] // identical
    [InlineData("Pizza", "PIZZA", 1f)] // case-insensitive
    [InlineData("  pizza  ", "pizza", 1f)] // whitespace-trimmed
    [InlineData("pizza", "sushi", 0f)] // different
    [InlineData("", "anything", 0f)] // empty lhs
    [InlineData("anything", "", 0f)] // empty rhs
    [InlineData(null, "anything", 0f)] // null lhs
    public async Task CheckSimilarity_AppliesNormalisationRules(string? lhs, string? rhs, float expected)
    {
        var score = await _service.CheckAnswerSimilarityAsync(lhs!, rhs!);
        score.Should().Be(expected);
    }

    [Fact]
    public async Task GenerateQuestion_RespectsExplicitCategory()
    {
        var q = await _service.GenerateQuestionAsync(QuestionCategory.Hobbies);
        q.Category.Should().Be(QuestionCategory.Hobbies);
    }
}
