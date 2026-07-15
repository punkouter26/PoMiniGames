using Microsoft.Extensions.Logging;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// Source-generated, zero-allocation log messages for the PoFunQuiz AI path. The
/// <c>[LoggerMessage]</c> source generator emits strongly-typed, cached delegates so these
/// high-frequency call sites avoid the boxing and template-parsing cost of the
/// <c>ILogger.LogX(string, params object[])</c> overloads.
/// </summary>
internal static partial class FunQuizLog
{
    [LoggerMessage(EventId = 4101, Level = LogLevel.Warning,
        Message = "PoFunQuiz: UseMockAI=true in {Environment}; serving mock questions.")]
    public static partial void MockEnabled(this ILogger logger, string environment);

    [LoggerMessage(EventId = 4102, Level = LogLevel.Warning,
        Message = "PoFunQuiz: Azure OpenAI not configured; serving mock questions in {Environment}.")]
    public static partial void NotConfigured(this ILogger logger, string environment);

    [LoggerMessage(EventId = 4103, Level = LogLevel.Error,
        Message = "PoFunQuiz: Azure OpenAI question generation failed for category {Category} (count {Count}).")]
    public static partial void GenerationFailed(this ILogger logger, Exception ex, QuestionCategory category, int count);

    [LoggerMessage(EventId = 4104, Level = LogLevel.Information,
        Message = "PoFunQuiz game {Code} created by {Host}")]
    public static partial void GameCreated(this ILogger logger, string code, string host);

    [LoggerMessage(EventId = 4105, Level = LogLevel.Information,
        Message = "PoFunQuiz {Code}: {Name} joined")]
    public static partial void PlayerJoined(this ILogger logger, string code, string name);
}
