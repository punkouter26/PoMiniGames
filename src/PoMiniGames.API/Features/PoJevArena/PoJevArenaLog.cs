using Microsoft.Extensions.Logging;

namespace PoMiniGames.Features.PoJevArena;

/// <summary>Source-generated log messages for the PoJevArena slice (EventIds 4800-4899).</summary>
internal static partial class PoJevArenaLog
{
    [LoggerMessage(EventId = 4801, Level = LogLevel.Warning,
        Message = "PoJevArena: Jev returned HTTP {Status}; the unit holds its last intent.")]
    public static partial void JevHttpFailure(this ILogger logger, int status);

    [LoggerMessage(EventId = 4802, Level = LogLevel.Warning,
        Message = "PoJevArena: Jev request failed at the network layer; the unit holds its last intent.")]
    public static partial void JevNetworkFailure(this ILogger logger, Exception ex);

    [LoggerMessage(EventId = 4803, Level = LogLevel.Warning,
        Message = "PoJevArena: no Jev key configured (PoMiniGames:Jev:ApiKey); the arena reports itself unavailable.")]
    public static partial void JevNotConfigured(this ILogger logger);

    [LoggerMessage(EventId = 4804, Level = LogLevel.Warning,
        Message = "PoJevArena: serving the deterministic Jev stub ({Environment}).")]
    public static partial void JevStubEnabled(this ILogger logger, string environment);

    [LoggerMessage(EventId = 4805, Level = LogLevel.Information,
        Message = "PoJevArena: match {MatchId} batch of {Units} → {Ok} ok, {Failed} failed, ${CostUsd:0.000000} in {ElapsedMs} ms.")]
    public static partial void DecisionBatch(this ILogger logger, string matchId, int units, int ok, int failed, double costUsd, long elapsedMs);

    [LoggerMessage(EventId = 4806, Level = LogLevel.Warning,
        Message = "PoJevArena: creature library {Operation} failed; degrading.")]
    public static partial void LibraryFailed(this ILogger logger, Exception ex, string operation);

    [LoggerMessage(EventId = 4807, Level = LogLevel.Information,
        Message = "PoJevArena: match {MatchId} finished ({Winner}) after {Decisions} decisions, ${CostUsd:0.0000} total.")]
    public static partial void MatchFinished(this ILogger logger, string matchId, string winner, int decisions, double costUsd);
}
