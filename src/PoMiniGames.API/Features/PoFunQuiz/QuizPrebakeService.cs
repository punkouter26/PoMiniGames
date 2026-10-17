using Microsoft.Extensions.Options;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>Configuration for the background quiz-bank filler.</summary>
public sealed class QuizPrebakeOptions
{
    public const string SectionName = "PoMiniGames:AI:QuizPrebake";

    /// <summary>
    /// Whether to fill the question bank in the background. On by default: the filler uses the
    /// FREE sources only (the bundled set and Open Trivia DB) unless <see cref="AllowAiTopUp"/> is set.
    /// </summary>
    /// <remarks>
    /// This used to re-buy a batch of AI questions per category every five hours to keep a 6 h cache
    /// warm — the one background job in the host that deliberately spent money, so it was off by
    /// default. The bank is permanent now, so filling it is a one-time job that costs nothing.
    /// </remarks>
    public bool Enabled { get; set; } = true;

    /// <summary>How often to check the bank again. Once it is at target a pass is eight table reads.</summary>
    public TimeSpan Interval { get; set; } = TimeSpan.FromHours(12);

    /// <summary>
    /// Also top up with paid AI questions while a category is below target. <b>Off by default</b> —
    /// it is the only part of this job that spends money.
    /// </summary>
    public bool AllowAiTopUp { get; set; }

    /// <summary>
    /// Pause between categories. Open Trivia DB allows one call per five seconds per IP, so this must
    /// stay above five seconds or every other fetch comes back rate-limited.
    /// </summary>
    public TimeSpan DelayBetweenCategories { get; set; } = TimeSpan.FromSeconds(20);

    /// <summary>Categories to fill. Empty means every value of <see cref="QuestionCategory"/>.</summary>
    public string[] Categories { get; set; } = [];
}

/// <summary>
/// Low-frequency filler for the PoFunQuiz question bank: once after startup, then every
/// <see cref="QuizPrebakeOptions.Interval"/>, each category under target gets one Open Trivia DB batch
/// (and, on an empty bank, the bundled set). Paid AI top-ups only when explicitly enabled.
/// </summary>
/// <remarks>
/// The request path tops the bank up by itself as players arrive, so this job is a convenience that
/// gets a fresh deployment's bank full before anyone plays — nothing depends on it running.
/// </remarks>
public sealed class QuizPrebakeService : BackgroundService
{
    private readonly FunQuizQuestionService _questions;
    private readonly IOptionsMonitor<QuizPrebakeOptions> _options;
    private readonly ILogger<QuizPrebakeService> _logger;

    public QuizPrebakeService(
        FunQuizQuestionService questions,
        IOptionsMonitor<QuizPrebakeOptions> options,
        ILogger<QuizPrebakeService> logger)
    {
        _questions = questions;
        _options = options;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.CurrentValue.Enabled)
            return;

        // Let the host finish booting — storage init first. A filler competing with startup would
        // slow the thing players are waiting for.
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(1), stoppingToken);
        }
        catch (OperationCanceledException) { return; }

        while (!stoppingToken.IsCancellationRequested)
        {
            await FillOnceAsync(stoppingToken);

            var interval = _options.CurrentValue.Interval;
            if (interval < TimeSpan.FromHours(1))
                interval = TimeSpan.FromHours(1);

            try
            {
                await Task.Delay(interval, stoppingToken);
            }
            catch (OperationCanceledException) { return; }
        }
    }

    private async Task FillOnceAsync(CancellationToken stoppingToken)
    {
        var options = _options.CurrentValue;
        if (!options.Enabled) return;

        var categories = ResolveCategories(options);
        var delay = options.DelayBetweenCategories < TimeSpan.FromSeconds(6)
            ? TimeSpan.FromSeconds(6)
            : options.DelayBetweenCategories;
        var added = 0;

        foreach (var category in categories)
        {
            if (stoppingToken.IsCancellationRequested) return;

            try
            {
                added += await _questions.FillCategoryAsync(category, options.AllowAiTopUp, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // Swallowed: a failed fill costs a player nothing — the request path still deals
                // from the bundled set and tops up on demand.
                _logger.LogDebug(ex, "Quiz bank fill failed for category {Category}.", category);
            }

            try
            {
                await Task.Delay(delay, stoppingToken);
            }
            catch (OperationCanceledException) { return; }
        }

        _logger.LogInformation("Quiz bank fill pass complete: {Added} new question(s) across {Total} categories.",
            added, categories.Count);
    }

    /// <summary>
    /// Configured categories, or every value when none are named. An unrecognised name is dropped
    /// with a warning rather than failing the pass — a typo should cost one category, not all of them.
    /// </summary>
    private IReadOnlyList<QuestionCategory> ResolveCategories(QuizPrebakeOptions options)
    {
        if (options.Categories.Length == 0)
            return Enum.GetValues<QuestionCategory>();

        var resolved = new List<QuestionCategory>(options.Categories.Length);
        foreach (var name in options.Categories)
        {
            if (Enum.TryParse<QuestionCategory>(name, ignoreCase: true, out var category))
                resolved.Add(category);
            else
                _logger.LogWarning("Quiz bank filler: unrecognised category {Category}; skipping it.", name);
        }
        return resolved;
    }
}
