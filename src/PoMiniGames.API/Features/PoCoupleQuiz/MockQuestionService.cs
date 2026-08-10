namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// Deterministic, no-AI question service for tests and the in-Development
/// <c>UseMockAI = true</c> flag. Never registered in Production (the
/// <c>StartupSecretValidator</c> ensures Azure OpenAI secrets are present;
/// mock service registration is gated on <c>UseMockAI</c>).
/// </summary>
/// <remarks>
/// Pattern: Strategy (interchangeable with <see cref="AzureOpenAIQuestionService"/>).
/// The mock keeps the round flow alive when the upstream LLM is unreachable
/// during local dev or in CI test runs.
/// </remarks>
public sealed class MockQuestionService : IQuestionService
{
    // One pool. The three difficulty-keyed banks went with DifficultyLevel — the questions
    // were never actually harder, only differently worded, and nothing selected between them
    // that a player could perceive.
    private static readonly string[] Questions =
    [
        "What is your partner's favorite snack?",
        "What is your partner's favorite color?",
        "What is your partner's go-to comfort food?",
        "What is the title of your partner's comfort movie?",
        "What song does your partner sing in the shower?",
        "What is your partner's dream vacation destination?",
        "What is your partner's biggest irrational fear?",
        "What hobby would your partner pick up if money were no object?",
        "What is the most embarrassing thing on your partner's bucket list?"
    ];

    public Task<Question> GenerateQuestionAsync(QuestionCategory? category = null, CancellationToken cancellationToken = default)
    {
        // Deterministic based on ticks so multiple callers in the same test get the same answer.
        var idx = (int)(DateTime.UtcNow.Ticks % Questions.Length);
        var text = Questions[idx];
        var chosenCategory = category ?? QuestionCategory.Preferences;
        return Task.FromResult(new Question { Text = text, Category = chosenCategory });
    }

    public Task<float> CheckAnswerSimilarityAsync(string answer1, string answer2, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(answer1) || string.IsNullOrWhiteSpace(answer2))
        {
            return Task.FromResult(0f);
        }

        // Trivial deterministic similarity: case-insensitive whitespace-trimmed equality.
        var a = answer1.Trim().ToLowerInvariant();
        var b = answer2.Trim().ToLowerInvariant();
        return Task.FromResult(a == b ? 1f : 0f);
    }
}
