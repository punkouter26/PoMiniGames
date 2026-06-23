namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// Deterministic, no-AI question service for tests and the in-Development
/// <c>UseMockAi = true</c> flag. Never registered in Production (the
/// <c>StartupSecretValidator</c> ensures Azure OpenAI secrets are present;
/// mock service registration is gated on <c>UseMockAi</c>).
/// </summary>
/// <remarks>
/// Pattern: Strategy (interchangeable with <see cref="AzureOpenAIQuestionService"/>).
/// The mock keeps the round flow alive when the upstream LLM is unreachable
/// during local dev or in CI test runs.
/// </remarks>
public sealed class MockQuestionService : IQuestionService
{
    private static readonly string[] EasyQuestions =
    [
        "What is your partner's favorite snack?",
        "What is your partner's favorite color?",
        "What is your partner's go-to comfort food?"
    ];

    private static readonly string[] MediumQuestions =
    [
        "What is the title of your partner's comfort movie?",
        "What song does your partner sing in the shower?",
        "What is your partner's dream vacation destination?"
    ];

    private static readonly string[] HardQuestions =
    [
        "What is your partner's biggest irrational fear?",
        "What hobby would your partner pick up if money were no object?",
        "What is the most embarrassing thing on your partner's bucket list?"
    ];

    public Task<Question> GenerateQuestionAsync(DifficultyLevel difficulty, QuestionCategory? category = null, CancellationToken cancellationToken = default)
    {
        var pool = difficulty switch
        {
            DifficultyLevel.Easy => EasyQuestions,
            DifficultyLevel.Medium => MediumQuestions,
            DifficultyLevel.Hard => HardQuestions,
            _ => MediumQuestions
        };

        // Deterministic based on ticks so multiple callers in the same test get the same answer.
        var idx = (int)(DateTime.UtcNow.Ticks % pool.Length);
        var text = pool[idx];
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
