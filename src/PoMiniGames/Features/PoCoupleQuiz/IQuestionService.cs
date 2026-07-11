namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// Generates a question for the King and scores how semantically close a Guesser
/// answer is to the King's secret answer. Used by the round evaluation use case.
/// </summary>
public interface IQuestionService
{
    /// <summary>Generate a single question for the given difficulty. The King types
    /// their answer to this; the rest of the lobby then tries to match it.</summary>
    /// <param name="difficulty">Easy / Medium / Hard. Hard asks deeper/funnier questions.</param>
    /// <param name="category">Optional preferred category (Relationships, Hobbies, ...).
    /// When null, the service picks one aligned with the difficulty.</param>
    /// <param name="cancellationToken">Cancellation.</param>
    Task<Question> GenerateQuestionAsync(DifficultyLevel difficulty, QuestionCategory? category = null, CancellationToken cancellationToken = default);

    /// <summary>Score the semantic similarity between two short answers, returning
    /// a value in [0.0, 1.0]. 1.0 means identical meaning.</summary>
    Task<float> CheckAnswerSimilarityAsync(string answer1, string answer2, CancellationToken cancellationToken = default);
}
