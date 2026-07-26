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

    [LoggerMessage(EventId = 5105, Level = LogLevel.Information,
        Message = "Lobby {Code} created by {Host}")]
    public static partial void LobbyCreated(this ILogger logger, string code, string? host);

    [LoggerMessage(EventId = 5106, Level = LogLevel.Information,
        Message = "JoinOrCreate: lobby {Code} created by {Host}")]
    public static partial void JoinOrCreateLobbyCreated(this ILogger logger, string code, string? host);
}
