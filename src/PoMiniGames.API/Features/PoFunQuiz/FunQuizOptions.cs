using PoMiniGames.Features.Shared;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>Where one request's questions come from.</summary>
public enum QuizSourceMode
{
    /// <summary>The free question bank (Open Trivia DB, the bundled set, earlier AI top-ups).</summary>
    Bank,

    /// <summary>Newly written by the paid model. Opt-in, signed-in players only.</summary>
    FreshAi,
}

/// <summary>
/// Tunables for PoFunQuiz, from the <c>PoFunQuiz</c> configuration section. Read through
/// <c>IOptionsSnapshot</c> on request paths and <c>IOptionsMonitor</c> in singletons, so a
/// changed value applies without a restart.
/// </summary>
/// <remarks>
/// This replaces the raw <c>IConfiguration.GetValue("PoFunQuiz:Features:UseMockAI")</c> read the
/// generator used to make, so both quiz games now bind their switches the same way
/// (see <c>CoupleQuizOptions</c>). The key names are unchanged.
/// </remarks>
public sealed class FunQuizOptions
{
    public const string SectionName = "PoFunQuiz";

    /// <summary>Configuration value of <see cref="QuestionSource"/> that means the paid model.</summary>
    public const string FreshAiValue = "FreshAi";

    /// <summary>
    /// Default source when a request does not say: <c>Bank</c> (free) or <c>FreshAi</c>.
    /// Even <c>FreshAi</c> here only applies to signed-in callers while <see cref="AllowFreshAi"/> is on.
    /// </summary>
    public string QuestionSource { get; set; } = "Bank";

    /// <summary>Kill switch for the paid path. Off means every request is served from the bank.</summary>
    public bool AllowFreshAi { get; set; } = true;

    /// <summary>How many questions per category the bank grows to before top-ups stop.</summary>
    public int BankTargetPerCategory { get; set; } = 300;

    public FunQuizFeatures Features { get; set; } = new();

    public OpenTriviaDbOptions OpenTriviaDb { get; set; } = new();

    /// <summary>
    /// The mode one request is served with. The paid path needs all three: it was asked for (or is
    /// the configured default), the kill switch allows it, and the caller is a real signed-in
    /// player rather than a guest.
    /// </summary>
    public QuizSourceMode Resolve(string? requested, bool callerAuthenticated) =>
        QuizPreferenceGate.PaidOptionOn(requested, FreshAiValue, QuestionSource, AllowFreshAi, callerAuthenticated)
            ? QuizSourceMode.FreshAi
            : QuizSourceMode.Bank;
}

public sealed class FunQuizFeatures
{
    /// <summary>
    /// Serve canned questions on the AI path (Development/Test only; ignored in Production).
    /// Canonical key: <c>PoFunQuiz:Features:UseMockAI</c>. The test budget guard forces it on.
    /// </summary>
    public bool UseMockAI { get; set; }
}

public sealed class OpenTriviaDbOptions
{
    /// <summary>Whether the bank may top itself up from opentdb.com. Off in every test host.</summary>
    public bool Enabled { get; set; } = true;

    public string BaseUrl { get; set; } = "https://opentdb.com/api.php";

    /// <summary>Per-call ceiling. A slow trivia API must never hold a player's quiz hostage.</summary>
    public int TimeoutSeconds { get; set; } = 5;
}
