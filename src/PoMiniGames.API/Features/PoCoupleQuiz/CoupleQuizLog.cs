using Microsoft.Extensions.Logging;

namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// Source-generated <see cref="ILogger"/> extension methods for PoCoupleQuiz. Using
/// <c>[LoggerMessage]</c> means the format string is emitted at compile time, the
/// delegate is cached, and disabled levels cost zero allocations — vs the legacy
/// <c>LogInformation("foo {Bar}", bar)</c> shape which boxes arguments and rebuilds
/// the message template on every call.
/// </summary>
internal static partial class CoupleQuizLog
{
    [LoggerMessage(EventId = 5101, Level = LogLevel.Error,
        Message = "PoCoupleQuiz: Azure OpenAI question generation failed.")]
    public static partial void QuestionGenerationFailed(this ILogger logger, Exception ex);

    [LoggerMessage(EventId = 5102, Level = LogLevel.Warning,
        Message = "PoCoupleQuiz: UseMockAI=true in {Environment}; serving mock question (non-prod only).")]
    public static partial void UsingMockQuestion(this ILogger logger, string environment);

    [LoggerMessage(EventId = 5103, Level = LogLevel.Warning,
        Message = "PoCoupleQuiz: AIFoundry not configured; serving mock question in {Environment}.")]
    public static partial void FoundryUnconfiguredUsingMock(this ILogger logger, string environment);

    [LoggerMessage(EventId = 5104, Level = LogLevel.Error,
        Message = "PoCoupleQuiz: Azure OpenAI similarity scoring failed.")]
    public static partial void SimilarityScoringFailed(this ILogger logger, Exception ex);

    // 5105/5106 both logged "lobby {Code} created by {Host}" from the two join paths.
    // There is one lobby and one join path now, so there is one message.
    [LoggerMessage(EventId = 5105, Level = LogLevel.Information,
        Message = "PoCoupleQuiz: lobby opened by {Host}")]
    public static partial void LobbyOpened(this ILogger logger, string? host);

    [LoggerMessage(EventId = 5107, Level = LogLevel.Error,
        Message = "PoCoupleQuiz: the round timer callback threw; the lobby is left recoverable.")]
    public static partial void RoundTimerFailed(this ILogger logger, Exception ex);

    [LoggerMessage(EventId = 5108, Level = LogLevel.Error,
        Message = "PoCoupleQuiz: could not generate the next question; the match will end early.")]
    public static partial void RoundAdvanceFailed(this ILogger logger, Exception ex);
}
