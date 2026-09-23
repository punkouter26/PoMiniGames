using Microsoft.Extensions.Logging;

namespace PoMiniGames.Features.PoBrawl;

/// <summary>Source-generated log messages for the PoBrawl slice (same shape as EcosystemLog).</summary>
internal static partial class PoBrawlLog
{
    [LoggerMessage(EventId = 4701, Level = LogLevel.Warning,
        Message = "PoBrawl: UseMockAI=true in {Environment}; the press conference serves canned lines.")]
    public static partial void PresserMockEnabled(this ILogger logger, string environment);

    [LoggerMessage(EventId = 4702, Level = LogLevel.Warning,
        Message = "PoBrawl: press-conference line failed; serving a canned one.")]
    public static partial void PresserFailed(this ILogger logger, Exception ex);
}
