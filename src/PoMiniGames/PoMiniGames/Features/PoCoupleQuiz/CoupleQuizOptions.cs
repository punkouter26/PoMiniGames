namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// Tunable timing for PoCoupleQuiz. Values come from <c>appsettings.json</c> section
/// <c>PoCoupleQuiz</c>. Per the user's 2026-06-23 consolidation decision, secrets come
/// from Key Vault under the prefix <c>PoMiniGames--PoCoupleQuiz--*</c>.
/// </summary>
public sealed class CoupleQuizOptions
{
    public const string SectionName = "PoCoupleQuiz";

    /// <summary>Time the King has to type their secret answer before the round auto-evaluates.</summary>
    public int KingAnswerTimeSeconds { get; set; } = 45;

    /// <summary>Time the Guessers have to type their answer on an Easy round.</summary>
    public int PlayerAnswerTimeEasySeconds { get; set; } = 40;

    /// <summary>Time the Guessers have to type their answer on a Medium round.</summary>
    public int PlayerAnswerTimeMediumSeconds { get; set; } = 30;

    /// <summary>Time the Guessers have to type their answer on a Hard round.</summary>
    public int PlayerAnswerTimeHardSeconds { get; set; } = 20;

    /// <summary>Maximum words allowed in a single answer (per the 2026 design).</summary>
    public int MaxAnswerWords { get; set; } = 2;

    /// <summary>Pre-round countdown shown to all players before the question reveals.</summary>
    public int PreRoundCountdownSeconds { get; set; } = 3;

    /// <summary>Sub-feature toggles.</summary>
    public CoupleQuizFeatures Features { get; set; } = new();
}

public sealed class CoupleQuizFeatures
{
    /// <summary>If true, the in-process mock question service is used even when Azure OpenAI
    /// is reachable. NEVER set this in Production — it bypasses real AI scoring.</summary>
    public bool UseMockAi { get; set; } = false;

    /// <summary>Default AI engine presented to the client ("Remote" Azure OpenAI, or
    /// "Browser" in-browser Transformers.js).</summary>
    public string DefaultAiMode { get; set; } = "Remote";
}
