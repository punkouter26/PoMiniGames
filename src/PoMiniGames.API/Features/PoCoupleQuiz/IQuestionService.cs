namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// Generates a question for the King and scores how semantically close a Guesser
/// answer is to the King's secret answer. Used by the round evaluation use case.
/// </summary>
public interface IQuestionService
{
    /// <summary>Generate a single question. The King types their answer to it; the rest of
    /// the lobby then tries to match that answer.</summary>
    /// <param name="category">Optional preferred category (Relationships, Hobbies, ...).
    /// When null, the service picks one.</param>
    /// <param name="cancellationToken">Cancellation.</param>
    /// <remarks>
    /// There is no difficulty parameter. The old <c>DifficultyLevel</c> was presented to
    /// players as "Difficulty" but only ever chose the round count (3/5/7); the lobby now
    /// asks for rounds directly and this call asks for a question.
    /// </remarks>
    Task<Question> GenerateQuestionAsync(QuestionCategory? category = null, CancellationToken cancellationToken = default);

    /// <summary>Score the semantic similarity between two short answers, returning
    /// a value in [0.0, 1.0]. 1.0 means identical meaning.</summary>
    Task<float> CheckAnswerSimilarityAsync(string answer1, string answer2, CancellationToken cancellationToken = default);
}
