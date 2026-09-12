using Microsoft.Extensions.Options;
using PoMiniGames.AI;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>Configuration for the off-peak quiz pre-bake.</summary>
public sealed class QuizPrebakeOptions
{
    public const string SectionName = "PoMiniGames:AI:QuizPrebake";

    /// <summary>
    /// Whether to warm the question cache in the background. <b>Off by default.</b>
    /// </summary>
    /// <remarks>
    /// This is the one background job in the host that deliberately spends money, so it does not
    /// get to switch itself on. Enabling it trades a small, fixed, predictable cost — one batch per
    /// category per <see cref="Interval"/> — for a player never waiting on a generation call. Left
    /// off, PoFunQuiz behaves exactly as before: the first player to ask for a category pays for it
    /// and everyone after them is served from the cache.
    /// </remarks>
    public bool Enabled { get; set; }

    /// <summary>How often to re-warm. Should sit just inside the cache's own expiration.</summary>
    /// <remarks>
    /// The question cache expires at 6 h (see <c>AiQuizGeneratorService</c>). Re-warming on a
    /// slightly shorter cycle means an entry is refreshed shortly before it lapses, so there is no
    /// window in which a player arrives to a cold category. A longer interval than the cache TTL
    /// would leave exactly that window and make the job pointless.
    /// </remarks>
    public TimeSpan Interval { get; set; } = TimeSpan.FromHours(5);

    /// <summary>
    /// Questions per pre-baked batch. Matches the batch size the request path asks for, because a
    /// different number is a different cache key and would warm an entry nobody reads.
    /// </summary>
    public int BatchSize { get; set; } = 12;

    /// <summary>
    /// Pause between categories, so the pre-bake trickles instead of stampeding.
    /// </summary>
    /// <remarks>
    /// The concurrency gate would serialise these anyway, but queueing eight batches behind it
    /// would push a live player's call to the back of that queue. Spacing them keeps the job
    /// invisible to anyone actually playing.
    /// </remarks>
    public TimeSpan DelayBetweenCategories { get; set; } = TimeSpan.FromSeconds(20);

    /// <summary>
    /// Categories to warm. Empty means every value of <see cref="QuestionCategory"/>.
    /// </summary>
    /// <remarks>
    /// Narrow this to the categories players actually pick and the job costs proportionally less.
    /// The default is everything because the host has no usage telemetry to pick from.
    /// </remarks>
    public string[] Categories { get; set; } = [];
}

/// <summary>
/// Generates a batch of questions per category in the background so the cache is warm before a
/// player asks.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why this is worth a background job.</b> Question generation is the most expensive call in the
/// host — a batch of twelve, with the largest output ceiling of any prompt here — and it is
/// perfectly cacheable: the prompt for a (category, count) pair is identical every time. The cache
/// was already there; what was missing was anything putting entries in it other than a player
/// waiting for one. This does that on a schedule instead.
/// </para>
/// <para>
/// <b>It relies on the L2 being durable.</b> Pre-baking into an in-process cache would be pointless
/// on F1, where the host is recycled on idle — the job would warm a cache that is empty again by
/// the time anyone visits. It is only worth running now that <c>TableDistributedCache</c> backs
/// HybridCache, which is why it arrived with it.
/// </para>
/// <para>
/// <b>Spend is attributed to nobody.</b> Like <see cref="AiWarmupService"/>, this opens no identity
/// scope: it is infrastructure spend, not a player's, and charging it to an arbitrary identity
/// would eat a real person's daily allowance. It is still bounded by the concurrency gate and the
/// circuit breaker like every other call.
/// </para>
/// </remarks>
public sealed class QuizPrebakeService : BackgroundService
{
    private readonly IServiceProvider _services;
    private readonly IOptionsMonitor<QuizPrebakeOptions> _options;
    private readonly IOptionsMonitor<AIFoundryOptions> _foundry;
    private readonly ILogger<QuizPrebakeService> _logger;

    public QuizPrebakeService(
        IServiceProvider services,
        IOptionsMonitor<QuizPrebakeOptions> options,
        IOptionsMonitor<AIFoundryOptions> foundry,
        ILogger<QuizPrebakeService> logger)
    {
        _services = services;
        _options = options;
        _foundry = foundry;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.CurrentValue.Enabled)
            return;

        // Let the host finish booting — storage init and deployment validation first. A pre-bake
        // competing with startup would slow the thing it exists to speed up.
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(1), stoppingToken);
        }
        catch (OperationCanceledException) { return; }

        while (!stoppingToken.IsCancellationRequested)
        {
            await PrebakeOnceAsync(stoppingToken);

            var interval = _options.CurrentValue.Interval;
            if (interval < TimeSpan.FromMinutes(15))
                interval = TimeSpan.FromMinutes(15);

            try
            {
                await Task.Delay(interval, stoppingToken);
            }
            catch (OperationCanceledException) { return; }
        }
    }

    private async Task PrebakeOnceAsync(CancellationToken stoppingToken)
    {
        var options = _options.CurrentValue;
        if (!options.Enabled || !_foundry.CurrentValue.IsConfigured)
            return;

        var categories = ResolveCategories(options);
        var batchSize = Math.Clamp(options.BatchSize, 1, 50);
        var warmed = 0;

        foreach (var category in categories)
        {
            if (stoppingToken.IsCancellationRequested) return;

            try
            {
                // A scope per category: the generator is a singleton, but resolving through a scope
                // keeps this consistent with how request paths reach it and costs nothing.
                using var scope = _services.CreateScope();
                var generator = scope.ServiceProvider.GetRequiredService<IOpenAIService>();

                // GenerateQuizQuestionsAsync goes through HybridCache, so a category that is still
                // cached costs a cache read and no model call. The job is therefore self-skipping:
                // it only spends on what has actually lapsed.
                var questions = await generator.GenerateQuizQuestionsAsync(category, batchSize, stoppingToken);
                if (questions.Count > 0) warmed++;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // Swallowed: a pre-bake failure costs a player nothing — the request path still
                // generates on demand. The health check and usage read-model already carry the
                // provider's state, so this adds no second alarm channel.
                _logger.LogDebug(ex, "Quiz pre-bake failed for category {Category}.", category);
            }

            try
            {
                await Task.Delay(options.DelayBetweenCategories, stoppingToken);
            }
            catch (OperationCanceledException) { return; }
        }

        _logger.LogInformation(
            "Quiz pre-bake pass complete: {Warmed}/{Total} categories hold a batch of {BatchSize}.",
            warmed, categories.Count, batchSize);
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
                _logger.LogWarning("Quiz pre-bake: unrecognised category {Category}; skipping it.", name);
        }
        return resolved;
    }
}
