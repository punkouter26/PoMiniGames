namespace PoMiniGames.Features.Shared;

/// <summary>
/// The one rule both quiz games use to decide whether a paid AI option is on for a caller.
/// </summary>
/// <remarks>
/// The free path is the default everywhere. A paid option (FunQuiz/CoupleQuiz "Fresh AI" questions,
/// CoupleQuiz's "AI judge") is on only when it was asked for — or is the server's configured default
/// and the client did not say — AND the server's kill switch allows it AND the caller is a real
/// signed-in player. Guests never reach a paid model through these options.
/// </remarks>
public static class QuizPreferenceGate
{
    /// <param name="requested">What the client asked for; null/blank means "no preference".</param>
    /// <param name="paidValue">The token that names the paid option, e.g. <c>FreshAi</c>.</param>
    /// <param name="serverDefault">The configured default, used only when nothing was requested.</param>
    /// <param name="allowed">The server-side kill switch for the paid option.</param>
    /// <param name="callerAuthenticated">True for a signed-in, non-guest identity.</param>
    public static bool PaidOptionOn(
        string? requested, string paidValue, string? serverDefault, bool allowed, bool callerAuthenticated)
    {
        var wanted = string.IsNullOrWhiteSpace(requested)
            ? string.Equals(serverDefault?.Trim(), paidValue, StringComparison.OrdinalIgnoreCase)
            : string.Equals(requested.Trim(), paidValue, StringComparison.OrdinalIgnoreCase);
        return wanted && allowed && callerAuthenticated;
    }
}
