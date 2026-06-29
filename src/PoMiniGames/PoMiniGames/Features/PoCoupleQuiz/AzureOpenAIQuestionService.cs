using System.Text.Json;
using Microsoft.Extensions.Caching.Hybrid;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using OpenAI.Chat;

namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// Wraps the centralized Azure AI Foundry hub for PoCoupleQuiz question generation
/// and answer-similarity scoring. The <c>couplequiz</c> deployment is resolved through
/// <see cref="AIFoundryChatClientCache"/>.
///
/// <para><b>Mock fallback</b>: per the 2026-06-13 mock-data fix (see user memory
/// <c>pofunquiz-mock-data-fix.md</c>), the fallback to <see cref="MockQuestionService"/>
/// is gated on <c>IsDevelopment() || IsEnvironment("Test")</c> AND the explicit
/// <c>PoCoupleQuiz:Features:UseMockAI</c> flag. In Production, missing config
/// causes an <see cref="InvalidOperationException"/> on first call rather than
/// silently serving fabricated data.</para>
/// </summary>
public sealed class AzureOpenAIQuestionService : IQuestionService
{
    private readonly IOptionsMonitor<CoupleQuizOptions> _optionsMonitor;
    private readonly ILogger<AzureOpenAIQuestionService> _logger;
    private readonly IHostEnvironment _environment;
    private readonly HybridCache _cache;
    private readonly AIFoundryChatClientCache _chatClientCache;
    private readonly MockQuestionService _mock;

    public AzureOpenAIQuestionService(
        IOptionsMonitor<CoupleQuizOptions> optionsMonitor,
        IConfiguration configuration,
        IHostEnvironment environment,
        HybridCache cache,
        ILogger<AzureOpenAIQuestionService> logger,
        AIFoundryChatClientCache chatClientCache,
        MockQuestionService mock)
    {
        _optionsMonitor = optionsMonitor;
        _environment = environment;
        _cache = cache;
        _logger = logger;
        _chatClientCache = chatClientCache;
        _mock = mock;
    }

    public async Task<Question> GenerateQuestionAsync(DifficultyLevel difficulty, QuestionCategory? category = null, CancellationToken cancellationToken = default)
    {
        var options = _optionsMonitor.CurrentValue;
        if (options.Features.UseMockAI && IsNonProduction())
        {
            _logger.UsingMockQuestion(_environment.EnvironmentName);
            return await _mock.GenerateQuestionAsync(difficulty, category, cancellationToken);
        }

        var chatClient = _chatClientCache.Resolve(AIFoundryOptions.Games.CoupleQuiz);
        if (chatClient is null)
        {
            if (IsNonProduction())
            {
                _logger.FoundryUnconfiguredUsingMock(_environment.EnvironmentName);
                return await _mock.GenerateQuestionAsync(difficulty, category, cancellationToken);
            }
            throw new InvalidOperationException(
                $"PoCoupleQuiz: AIFoundry not configured. Set {AIFoundryOptions.SectionName} in Key Vault (kv-poshared).");
        }

        var categoryHint = category?.ToString() ?? "any category";
        var systemPrompt = "You generate short, playful trivia questions for couples. " +
                           "Respond with a JSON object: {\"text\":\"<question>\",\"category\":\"<Relationships|Hobbies|Childhood|Future|Preferences|Values>\"}. " +
                           "Keep the question under 12 words. No explanations.";
        var userPrompt = $"Difficulty: {difficulty}. Category preference: {categoryHint}. " +
                          "Generate one question appropriate for the King to answer, then have the other players guess.";

        try
        {
            var messages = new List<ChatMessage>
            {
                new SystemChatMessage(systemPrompt),
                new UserChatMessage(userPrompt)
            };
            var chatOptions = new ChatCompletionOptions { ResponseFormat = ChatResponseFormat.CreateJsonObjectFormat() };
            var completion = await chatClient.CompleteChatAsync(messages, chatOptions, cancellationToken);

            var json = completion.Value.Content[0].Text;
            using var doc = JsonDocument.Parse(json);
            var text = doc.RootElement.GetProperty("text").GetString() ?? "What's your favorite thing about us?";
            var cat = doc.RootElement.TryGetProperty("category", out var c) && Enum.TryParse<QuestionCategory>(c.GetString(), out var parsed)
                ? parsed
                : QuestionCategory.Preferences;
            return new Question { Text = text, Category = cat };
        }
        catch (Exception ex)
        {
            _logger.QuestionGenerationFailed(ex);
            if (IsNonProduction())
            {
                return await _mock.GenerateQuestionAsync(difficulty, category, cancellationToken);
            }
            throw;
        }
    }

    public async Task<float> CheckAnswerSimilarityAsync(string answer1, string answer2, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(answer1) || string.IsNullOrWhiteSpace(answer2))
        {
            return 0f;
        }

        var options = _optionsMonitor.CurrentValue;
        if (options.Features.UseMockAI && IsNonProduction())
        {
            return await _mock.CheckAnswerSimilarityAsync(answer1, answer2, cancellationToken);
        }

        if (_chatClientCache.Resolve(AIFoundryOptions.Games.CoupleQuiz) is null)
        {
            if (IsNonProduction())
            {
                return await _mock.CheckAnswerSimilarityAsync(answer1, answer2, cancellationToken);
            }
            throw new InvalidOperationException(
                $"PoCoupleQuiz: AIFoundry not configured. Set {AIFoundryOptions.SectionName} in Key Vault (kv-poshared).");
        }

        // Similarity scoring is deterministic for a given unordered answer pair, so memoize it.
        var (a, b) = string.CompareOrdinal(answer1, answer2) <= 0 ? (answer1, answer2) : (answer2, answer1);
        var cacheKey = $"couplequiz:sim:{a.Trim().ToLowerInvariant()}|{b.Trim().ToLowerInvariant()}";
        return await _cache.GetOrCreateAsync(
            cacheKey,
            (Service: this, a, b),
            static (state, ct) => state.Service.ScoreSimilarityAsync(state.a, state.b, ct),
            cancellationToken: cancellationToken);
    }

    private async ValueTask<float> ScoreSimilarityAsync(string answer1, string answer2, CancellationToken cancellationToken)
    {
        var systemPrompt = "You score semantic similarity between two short answers on a 0.0-1.0 scale. " +
                           "Respond with a JSON object: {\"score\":<float between 0.0 and 1.0>}. " +
                           "1.0 means identical meaning; 0.0 means unrelated.";
        var userPrompt = $"Answer A: {answer1}\nAnswer B: {answer2}\nReturn only the JSON.";

        try
        {
            var messages = new List<ChatMessage>
            {
                new SystemChatMessage(systemPrompt),
                new UserChatMessage(userPrompt)
            };
            var chatOptions = new ChatCompletionOptions { ResponseFormat = ChatResponseFormat.CreateJsonObjectFormat() };
            // Non-null: callers (CheckAnswerSimilarityAsync) guard the cached client before invoking.
            var chat = _chatClientCache.Resolve(AIFoundryOptions.Games.CoupleQuiz)!;
            var completion = await chat.CompleteChatAsync(messages, chatOptions, cancellationToken);

            var json = completion.Value.Content[0].Text;
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("score", out var s) && s.TryGetSingle(out var v))
            {
                return Math.Clamp(v, 0f, 1f);
            }
            return 0f;
        }
        catch (Exception ex)
        {
            _logger.SimilarityScoringFailed(ex);
            if (IsNonProduction())
            {
                return await _mock.CheckAnswerSimilarityAsync(answer1, answer2, cancellationToken);
            }
            throw;
        }
    }

    private bool IsNonProduction() => _environment.IsDevelopment() || _environment.IsEnvironment("Test");
}
