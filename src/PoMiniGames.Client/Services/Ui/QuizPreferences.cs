using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Services.Ui;

/// <summary>
/// The two quiz options in the settings sheet, kept in localStorage:
/// <c>pomini_quiz_source</c> (<c>classic</c> | <c>fresh</c>) and
/// <c>pomini_answer_matching</c> (<c>smart</c> | <c>aijudge</c>). Both default to the free choice.
/// </summary>
/// <remarks>
/// These are requests, not grants: the server honours a paid option only for a signed-in player
/// while it is allowed server-side, and quietly serves the free path to everyone else.
/// </remarks>
public static class QuizPreferences
{
    public const string SourceKey = "pomini_quiz_source";
    public const string MatchingKey = "pomini_answer_matching";

    /// <summary>Fresh AI questions instead of the free question bank.</summary>
    public static bool FreshAi
    {
        get => Read(SourceKey) == "fresh";
        set => Write(SourceKey, value ? "fresh" : "classic");
    }

    /// <summary>Let the AI settle close calls in Couple Quiz answer matching.</summary>
    public static bool AiJudge
    {
        get => Read(MatchingKey) == "aijudge";
        set => Write(MatchingKey, value ? "aijudge" : "smart");
    }

    /// <summary>The token the API expects for the question source.</summary>
    public static string SourceParam => FreshAi ? "FreshAi" : "Bank";

    /// <summary>The token the API expects for answer matching.</summary>
    public static string MatchingParam => AiJudge ? "AiJudge" : "Smart";

    // Storage can be blocked (private mode, site data off, prerender); the free default stands then.
    private static string? Read(string key)
    {
        try { return LocalStorageService.GetItem<string>(key); }
        catch { return null; }
    }

    private static void Write(string key, string value)
    {
        try { LocalStorageService.SetItem(key, value); }
        catch { /* best-effort: the choice just will not survive a reload */ }
    }
}
