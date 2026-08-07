using Microsoft.Extensions.Logging;

namespace PoMiniGames.AI;

/// <summary>
/// Source-generated <see cref="ILogger"/> extensions for the shared AI Foundry path.
/// </summary>
/// <remarks>
/// Every model invocation in the solution used to be invisible: <c>ChatResponse.Usage</c> was
/// discarded at every call site, so nothing could answer "what did a PoSurvive match cost?" —
/// and nothing noticed when a deployment stopped answering entirely. Event ids start at 6200 to
/// stay clear of <c>AuthLog</c>'s 61xx block.
/// </remarks>
internal static partial class AiLog
{
    [LoggerMessage(EventId = 6200, Level = LogLevel.Information,
        Message = "AI call ok: game={Game} deployment={Deployment} inputTokens={InputTokens} outputTokens={OutputTokens} totalTokens={TotalTokens} elapsedMs={ElapsedMs}")]
    public static partial void AiCallCompleted(
        this ILogger logger, string game, string deployment,
        long inputTokens, long outputTokens, long totalTokens, long elapsedMs);

    [LoggerMessage(EventId = 6201, Level = LogLevel.Warning,
        Message = "AI call failed: game={Game} deployment={Deployment} elapsedMs={ElapsedMs} reason={Reason}")]
    public static partial void AiCallFailed(
        this ILogger logger, string game, string deployment, long elapsedMs, string reason, Exception ex);

    [LoggerMessage(EventId = 6202, Level = LogLevel.Critical,
        Message = "AI deployment '{Deployment}' configured for game '{Game}' does not exist on {Endpoint}. Available: {Available}. Fix PoMiniGames:AI:Deployments — every call to this game's model will fail with DeploymentNotFound.")]
    public static partial void DeploymentMissing(
        this ILogger logger, string deployment, string game, string endpoint, string available);

    [LoggerMessage(EventId = 6203, Level = LogLevel.Information,
        Message = "AI deployment validation passed: {Count} configured deployment(s) exist on {Endpoint}.")]
    public static partial void DeploymentValidationPassed(this ILogger logger, int count, string endpoint);

    [LoggerMessage(EventId = 6204, Level = LogLevel.Warning,
        Message = "AI deployment validation could not run against {Endpoint} ({Reason}); configured names are unverified.")]
    public static partial void DeploymentValidationSkipped(this ILogger logger, string endpoint, string reason);

    [LoggerMessage(EventId = 6205, Level = LogLevel.Warning,
        Message = "AI token budget exhausted for identity {Identity}: {Spent}/{Limit} tokens today. Refusing until {ResetUtc:O}.")]
    public static partial void TokenBudgetExhausted(
        this ILogger logger, string identity, long spent, long limit, DateTimeOffset resetUtc);

    [LoggerMessage(EventId = 6206, Level = LogLevel.Debug,
        Message = "AI call for game={Game} had no identity in scope; spend is unattributed and uncapped. Expected only for background work — an HTTP or hub-originated call should have had a scope opened for it.")]
    public static partial void AiCallUnattributed(this ILogger logger, string game);

    [LoggerMessage(EventId = 6207, Level = LogLevel.Information,
        Message = "AI embedding call ok: purpose={Purpose} deployment={Deployment} inputs={Inputs} totalTokens={TotalTokens} elapsedMs={ElapsedMs}")]
    public static partial void EmbeddingCallCompleted(
        this ILogger logger, string purpose, string deployment, int inputs, long totalTokens, long elapsedMs);

    [LoggerMessage(EventId = 6208, Level = LogLevel.Warning,
        Message = "AI embedding call failed: purpose={Purpose} deployment={Deployment} elapsedMs={ElapsedMs} reason={Reason}. Caller falls back to the chat path.")]
    public static partial void EmbeddingCallFailed(
        this ILogger logger, string purpose, string deployment, long elapsedMs, string reason, Exception ex);

    [LoggerMessage(EventId = 6209, Level = LogLevel.Warning,
        Message = "{Game}: model reply did not satisfy the expected shape ({Reason}). Raw: {Raw}")]
    public static partial void UnparseableReply(this ILogger logger, string game, string reason, string raw);
}
