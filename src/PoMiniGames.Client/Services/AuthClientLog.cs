using Microsoft.Extensions.Logging;

namespace PoMiniGamesClient.Services;

/// <summary>
/// Source-generated <see cref="ILogger"/> extensions for the WASM-side
/// <see cref="AuthStateService"/>. Replaces the legacy
/// <c>Console.Error.WriteLine($"...")</c> paths which bypassed Serilog enrichment
/// (no <c>UserId</c>, <c>SessionId</c>, <c>CorrelationId</c>).
/// </summary>
internal static partial class AuthClientLog
{
    [LoggerMessage(EventId = 7101, Level = LogLevel.Warning,
        Message = "AutoGuestLogin minted a session without user interaction. This is gated to Development via the server-side Production guard in Program.cs.")]
    public static partial void AutoGuestSessionMinted(this ILogger logger);

    [LoggerMessage(EventId = 7102, Level = LogLevel.Warning,
        Message = "Silent MSAL restore failed: {Reason}")]
    public static partial void SilentMsalRestoreFailed(this ILogger logger, string reason, Exception? ex);

    [LoggerMessage(EventId = 7103, Level = LogLevel.Warning,
        Message = "Microsoft sign-in is not fully configured. Set PoMiniGames:MicrosoftAuth:ClientId and ApiClientId via `dotnet user-secrets set` (see appsettings.Development.json for the path).")]
    public static partial void MicrosoftSignInNotConfigured(this ILogger logger);

    [LoggerMessage(EventId = 7104, Level = LogLevel.Information,
        Message = "Sign-in was cancelled by the user.")]
    public static partial void SignInCancelled(this ILogger logger);
}
