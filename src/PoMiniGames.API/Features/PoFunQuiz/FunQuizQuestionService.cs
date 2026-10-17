using System.Collections.Concurrent;
using Microsoft.Extensions.Options;
using PoMiniGames.Features.PoFunQuiz.Storage;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>Where PoFunQuiz gets a quiz's questions. The endpoint and the multiplayer lobby both go through this.</summary>
public interface IFunQuizQuestionSource
{
    /// <summary>
    /// <paramref name="count"/> questions for <paramref name="category"/>, dealt at random with
    /// shuffled options. <see cref="QuizSourceMode.FreshAi"/> asks the paid model (the caller has
    /// already checked the player may); anything that goes wrong there falls back to the bank.
    /// </summary>
    Task<IReadOnlyList<QuizQuestion>> GetQuestionsAsync(
        QuestionCategory category, int count, QuizSourceMode mode, CancellationToken cancellationToken = default);
}

/// <summary>
/// The free-by-default question pipeline: the Table Storage bank, topped up from Open Trivia DB,
/// with the bundled set as the floor. The paid model is used only for an opted-in Fresh AI request
/// or, when explicitly enabled, by the background filler.
/// </summary>
/// <remarks>
/// <para>
/// <b>Per-category pool in memory.</b> A quiz is dealt from an in-process pool: the bank's rows plus
/// the bundled set, reloaded from storage every <see cref="PoolRefresh"/>. Reading the table on every
/// quiz would cost a partition scan per game; the pool costs one per category per refresh.
/// </para>
/// <para>
/// <b>Top-ups.</b> When a pool is too small to give a quiz variety, the request fetches one batch from
/// Open Trivia DB (at most once per <see cref="TopUpCooldown"/> per category — the API allows one call
/// per five seconds per IP) and writes the new questions to the bank in the background. The bank
/// therefore fills itself from real traffic even with the filler switched off.
/// </para>
/// </remarks>
public sealed class FunQuizQuestionService : IFunQuizQuestionSource
{
    private static readonly TimeSpan PoolRefresh = TimeSpan.FromMinutes(15);
    private static readonly TimeSpan TopUpCooldown = TimeSpan.FromMinutes(2);

    /// <summary>A pool smaller than this (or twice the request) is topped up before dealing.</summary>
    private const int MinimumVariety = 30;

    private readonly QuizBankRepository _bank;
    private readonly OpenTriviaDbClient _openTdb;
    private readonly IOpenAIService _ai;
    private readonly IOptionsMonitor<FunQuizOptions> _options;
    private readonly IHostEnvironment _environment;
    private readonly ILogger<FunQuizQuestionService> _logger;
    private readonly ConcurrentDictionary<QuestionCategory, CategoryPool> _pools = new();

    public FunQuizQuestionService(
        QuizBankRepository bank,
        OpenTriviaDbClient openTdb,
        IOpenAIService ai,
        IOptionsMonitor<FunQuizOptions> options,
        IHostEnvironment environment,
        ILogger<FunQuizQuestionService> logger)
    {
        _bank = bank;
        _openTdb = openTdb;
        _ai = ai;
        _options = options;
        _environment = environment;
        _logger = logger;
    }

    public async Task<IReadOnlyList<QuizQuestion>> GetQuestionsAsync(
        QuestionCategory category, int count, QuizSourceMode mode, CancellationToken cancellationToken = default)
    {
        count = Math.Clamp(count, 1, AiQuizGeneratorService.MaxQuestionsPerCall);

        if (mode == QuizSourceMode.FreshAi)
        {
            try
            {
                var fresh = await _ai.GenerateQuizQuestionsAsync(category, count, cancellationToken);
                if (fresh.Count > 0)
                {
                    if (ShouldBankAiOutput()) _ = BankInBackgroundAsync(category, fresh, "AI");
                    return fresh;
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                // A failed paid call must not cost the player their quiz: the bank is always there.
                _logger.LogWarning(ex, "Fresh AI questions failed for {Category}; serving from the bank.", category);
            }
        }

        var pool = await EnsurePoolAsync(category, count, cancellationToken);
        return AiQuizGeneratorService.SelectVariedSet(pool, count);
    }

    /// <summary>
    /// One filler pass for a category: reads the bank, seeds the bundled set into an empty one and
    /// tops up from Open Trivia DB while it is under target. AI top-ups only when
    /// <paramref name="allowAiTopUp"/> — off unless an operator turns it on, because it spends money.
    /// Returns how many questions were newly banked.
    /// </summary>
    public async Task<int> FillCategoryAsync(QuestionCategory category, bool allowAiTopUp, CancellationToken cancellationToken)
    {
        var banked = await _bank.GetCategoryAsync(category, cancellationToken);
        if (banked is null) return 0; // storage unreachable: nothing to fill

        var target = Math.Max(1, _options.CurrentValue.BankTargetPerCategory);
        var added = 0;
        if (banked.Count == 0)
            added += await _bank.AddAsync(category, BundledQuizQuestions.For(category), "Bundled", cancellationToken);

        if (banked.Count + added < target && _openTdb.Enabled)
        {
            var fetched = await _openTdb.FetchAsync(category, OpenTriviaDbClient.MaxPerCall, cancellationToken);
            added += await _bank.AddAsync(category, fetched, "OpenTDB", cancellationToken);
        }

        if (allowAiTopUp && banked.Count + added < target)
        {
            var generated = await _ai.GenerateQuizQuestionsAsync(category, AiQuizGeneratorService.MaxQuestionsPerCall, cancellationToken);
            if (ShouldBankAiOutput()) added += await _bank.AddAsync(category, generated, "AI", cancellationToken);
        }

        if (added > 0) _pools.TryRemove(category, out _); // next request reloads with the new rows
        return added;
    }

    private async Task<IReadOnlyList<QuizQuestion>> EnsurePoolAsync(
        QuestionCategory category, int count, CancellationToken cancellationToken)
    {
        var pool = _pools.GetOrAdd(category, _ => new CategoryPool());
        var wanted = Math.Max(MinimumVariety, count * 2);
        var now = DateTimeOffset.UtcNow;
        if (now - pool.LoadedAt < PoolRefresh && (pool.Questions.Count >= wanted || now - pool.LastTopUp < TopUpCooldown))
            return pool.Questions;

        await pool.Gate.WaitAsync(cancellationToken);
        try
        {
            now = DateTimeOffset.UtcNow;
            if (now - pool.LoadedAt >= PoolRefresh)
            {
                pool.Reset(BundledQuizQuestions.For(category));
                if (await _bank.GetCategoryAsync(category, cancellationToken) is { } banked) pool.Merge(banked);
                // Stamped even when storage was unreachable, so a dead backend is retried per
                // refresh window rather than on every quiz.
                pool.LoadedAt = now;
            }

            var target = Math.Max(1, _options.CurrentValue.BankTargetPerCategory);
            if (pool.Questions.Count < wanted && pool.Questions.Count < target
                && _openTdb.Enabled && now - pool.LastTopUp >= TopUpCooldown)
            {
                pool.LastTopUp = now;
                var fetched = await _openTdb.FetchAsync(category, OpenTriviaDbClient.MaxPerCall, cancellationToken);
                var added = pool.Merge(fetched);
                if (added.Count > 0) _ = BankInBackgroundAsync(category, added, "OpenTDB");
            }

            return pool.Questions;
        }
        finally
        {
            pool.Gate.Release();
        }
    }

    /// <summary>
    /// AI output is banked only in Production with mocks off. Outside it the generator may hand back
    /// canned questions, and those must not end up in the permanent bank looking like real ones.
    /// </summary>
    private bool ShouldBankAiOutput() =>
        !Features.Shared.AiMockFallback.IsNonProduction(_environment) && !_options.CurrentValue.Features.UseMockAI;

    /// <summary>Detached write: the player's quiz never waits on the bank insert.</summary>
    private async Task BankInBackgroundAsync(QuestionCategory category, IReadOnlyList<QuizQuestion> questions, string source)
    {
        try
        {
            await _bank.AddAsync(category, questions, source, CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogInformation(ex, "Background bank write failed for {Category}.", category);
        }
    }

    /// <summary>Copy-on-write pool: readers take <see cref="Questions"/> without the gate.</summary>
    private sealed class CategoryPool
    {
        private readonly HashSet<string> _hashes = new(StringComparer.Ordinal);

        public SemaphoreSlim Gate { get; } = new(1, 1);
        public DateTimeOffset LoadedAt { get; set; } = DateTimeOffset.MinValue;
        public DateTimeOffset LastTopUp { get; set; } = DateTimeOffset.MinValue;
        public IReadOnlyList<QuizQuestion> Questions { get; private set; } = [];

        public void Reset(IEnumerable<QuizQuestion> seed)
        {
            _hashes.Clear();
            Questions = [];
            Merge(seed);
        }

        /// <summary>Adds what is new (by normalized hash) and returns exactly those.</summary>
        public List<QuizQuestion> Merge(IEnumerable<QuizQuestion> incoming)
        {
            var added = new List<QuizQuestion>();
            foreach (var q in incoming)
            {
                if (_hashes.Add(QuizQuality.Hash(q.Text))) added.Add(q);
            }
            if (added.Count > 0) Questions = [.. Questions, .. added];
            return added;
        }
    }
}
