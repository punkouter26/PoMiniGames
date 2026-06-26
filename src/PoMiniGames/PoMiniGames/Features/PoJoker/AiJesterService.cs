using Microsoft.Extensions.Hosting;
using OpenAI.Chat;
using PoMiniGames.AI;
using PoShared.Games.PoJoker;

namespace PoMiniGames.Features.PoJoker;

/// <summary>
/// AI-powered joke analysis service backed by the centralized Azure AI Foundry hub
/// in the <c>PoShared</c> resource group. The <c>joker</c> deployment is resolved
/// through <see cref="AIFoundryChatClientCache"/>.
///
/// <para><b>Mock fallback</b> follows the PoCoupleQuiz pattern: when the foundry is
/// not configured, the service falls back to <see cref="MockAnalysisService"/> in
/// non-Production environments and throws in Production (so a misconfigured deployment
/// never silently serves fabricated data). The shared
/// <see cref="PoMiniGames.Infrastructure.AI.AzureOpenAIResilience"/> options bound the
/// per-attempt network timeout and retry count.</para>
/// </summary>
public sealed class AiJesterService : IAnalysisService
{
    private readonly ILogger<AiJesterService> _logger;
    private readonly IHostEnvironment _environment;
    private readonly MockAnalysisService _mock;
    private readonly AIFoundryChatClientCache _chatClientCache;
    private readonly int _timeoutSeconds;

    private const string SystemPrompt = """
        You are a Digital Jester - an AI that tries to predict punchlines to jokes.
        Given a joke setup, you must predict what the punchline will be.
        Be creative and funny, but try to guess the actual punchline.
        Respond with ONLY the punchline, nothing else. No explanations, no "I think", just the punchline itself.
        Keep your response short and punchy.
        """;

    public AiJesterService(
        IConfiguration configuration,
        IHostEnvironment environment,
        MockAnalysisService mock,
        ILogger<AiJesterService> logger,
        AIFoundryChatClientCache chatClientCache)
    {
        _logger = logger;
        _environment = environment;
        _mock = mock;
        _chatClientCache = chatClientCache;
        _timeoutSeconds = configuration.GetValue("PoJoker:AzureOpenAI:TimeoutSeconds", 30);
    }

    private bool IsNonProduction() => _environment.IsDevelopment() || _environment.IsEnvironment("Test");

    public async Task<(JokeAnalysisDto Analysis, JokeRatingDto Rating)> AnalyzeJokeAsync(JokeDto joke, CancellationToken cancellationToken = default)
    {
        var chatClient = _chatClientCache.Resolve(AIFoundryOptions.Games.Joker);
        if (chatClient is null)
        {
            if (IsNonProduction())
            {
                _logger.LogWarning("PoJoker: AIFoundry not configured; serving mock analysis in {Environment}.", _environment.EnvironmentName);
                return await _mock.AnalyzeJokeAsync(joke, cancellationToken);
            }
            throw new InvalidOperationException(
                $"PoJoker: AIFoundry not configured. Set {AIFoundryOptions.SectionName} in Key Vault (kv-poshared).");
        }

        var analysisTask = PredictPunchlineAsync(chatClient, joke, cancellationToken);
        var ratingTask = RateJokeAsync(chatClient, joke, cancellationToken);
        await Task.WhenAll(analysisTask, ratingTask);
        return (analysisTask.Result, ratingTask.Result);
    }

    private async Task<JokeAnalysisDto> PredictPunchlineAsync(ChatClient chatClient, JokeDto joke, CancellationToken cancellationToken)
    {
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();

        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(TimeSpan.FromSeconds(_timeoutSeconds));

            var messages = new ChatMessage[]
            {
                new SystemChatMessage(SystemPrompt),
                new UserChatMessage($"Joke setup: \"{joke.Setup}\"")
            };

            var response = await chatClient.CompleteChatAsync(messages, cancellationToken: cts.Token);

            string aiPunchline;
            if (response.Value.FinishReason == ChatFinishReason.ContentFilter)
            {
                stopwatch.Stop();
                _logger.LogWarning(
                    "Content filter triggered for joke {JokeId}, Category={Category}, FinishReason={FinishReason}",
                    joke.Id, joke.Category, response.Value.FinishReason);
                aiPunchline = "[The Jester shrugs and delivers a safe, court-approved punchline.]";
            }
            else
            {
                aiPunchline = response.Value.Content[0].Text.Trim();
            }

            stopwatch.Stop();
            var similarityScore = CalculateSimilarity(joke.Punchline, aiPunchline);
            var isTriumph = similarityScore >= 0.55 && response.Value.FinishReason != ChatFinishReason.ContentFilter;

            _logger.LogInformation(
                "AI predicted punchline for joke {JokeId}: Similarity={Similarity:P1}, IsTriumph={IsTriumph}, LatencyMs={LatencyMs}",
                joke.Id, similarityScore, isTriumph, stopwatch.ElapsedMilliseconds);

            return new JokeAnalysisDto
            {
                OriginalJoke = joke,
                AiPunchline = aiPunchline,
                Confidence = response.Value.FinishReason == ChatFinishReason.Stop ? 0.9 : 0.5,
                IsTriumph = isTriumph,
                SimilarityScore = similarityScore,
                LatencyMs = stopwatch.ElapsedMilliseconds
            };
        }
        catch (OperationCanceledException)
        {
            stopwatch.Stop();
            _logger.LogWarning("AI prediction timeout or cancelled for joke {JokeId} after {Timeout}s", joke.Id, _timeoutSeconds);
            return new JokeAnalysisDto
            {
                OriginalJoke = joke,
                AiPunchline = "[The Jester took too long to respond.]",
                Confidence = 0.1,
                IsTriumph = false,
                SimilarityScore = 0.0,
                LatencyMs = stopwatch.ElapsedMilliseconds
            };
        }
        catch (Exception ex)
        {
            stopwatch.Stop();
            _logger.LogError(ex, "AI prediction failed for joke {JokeId}", joke.Id);
            return new JokeAnalysisDto
            {
                OriginalJoke = joke,
                AiPunchline = "[The Jester stumbled and cannot predict.]",
                Confidence = 0.0,
                IsTriumph = false,
                SimilarityScore = 0.0,
                LatencyMs = stopwatch.ElapsedMilliseconds
            };
        }
    }

    private async Task<JokeRatingDto> RateJokeAsync(ChatClient chatClient, JokeDto joke, CancellationToken cancellationToken)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(TimeSpan.FromSeconds(_timeoutSeconds));

            const string ratingPrompt = """
                Rate this joke on a scale of 0.0 to 1.0 for:
                - Originality: How unique and creative is it?
                - Cleverness: How smart or witty is the wordplay?
                - Humor: How funny is it overall?

                Respond in this exact format (just numbers, no text):
                originality: 0.X
                cleverness: 0.X
                humor: 0.X
                """;

            var messages = new ChatMessage[]
            {
                new SystemChatMessage(ratingPrompt),
                new UserChatMessage($"Joke: \"{joke.Setup}\" -> \"{joke.Punchline}\"")
            };

            var response = await chatClient.CompleteChatAsync(messages, cancellationToken: cts.Token);

            if (response.Value.FinishReason == ChatFinishReason.ContentFilter)
            {
                _logger.LogWarning("Content filter triggered while rating joke {JokeId}; returning neutral scores", joke.Id);
                return new JokeRatingDto
                {
                    Cleverness = 5,
                    Complexity = 5,
                    Difficulty = 5,
                    Rudeness = 1,
                    Commentary = "Rated by the Digital Jester's discerning wit. (Filtered)"
                };
            }

            var responseText = response.Value.Content[0].Text;
            var cleverness = (int)Math.Round((ExtractScore(responseText, "cleverness") ?? 0.5) * 10);
            var complexity = (int)Math.Round((ExtractScore(responseText, "originality") ?? 0.5) * 10);
            var difficulty = (int)Math.Round((ExtractScore(responseText, "humor") ?? 0.5) * 10);

            return new JokeRatingDto
            {
                Cleverness = cleverness,
                Complexity = complexity,
                Difficulty = difficulty,
                Rudeness = 1,
                Commentary = "Rated by the Digital Jester's discerning wit."
            };
        }
        catch (OperationCanceledException)
        {
            _logger.LogWarning("Joke rating timeout or cancelled for {JokeId} after {Timeout}s", joke.Id, _timeoutSeconds);
            return new JokeRatingDto { Cleverness = 5, Complexity = 5, Difficulty = 5, Rudeness = 1, Commentary = "Timed out during rating." };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Joke rating failed for {JokeId}", joke.Id);
            return new JokeRatingDto { Cleverness = 5, Complexity = 5, Difficulty = 5, Rudeness = 1, Commentary = "Error during rating." };
        }
    }

    private const string ExplainPrompt = """
        You are a comedy analyst. Given a joke's setup and punchline, write exactly 2 sentences:
        1. What expectation or misdirection the setup creates in the listener's mind.
        2. How the punchline subverts that expectation to produce the comedic effect.
        Be concise and insightful. Do not begin with "This joke" or repeat the joke text verbatim.
        """;

    public async Task<string> ExplainJokeAsync(JokeDto joke, CancellationToken cancellationToken = default)
    {
        var chat = _chatClientCache.Resolve(AIFoundryOptions.Games.Joker);
        if (chat is null)
        {
            if (IsNonProduction())
            {
                return await _mock.ExplainJokeAsync(joke, cancellationToken);
            }
            throw new InvalidOperationException(
                $"PoJoker: AIFoundry not configured. Set {AIFoundryOptions.SectionName} in Key Vault (kv-poshared).");
        }

        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(TimeSpan.FromSeconds(_timeoutSeconds));

            var messages = new ChatMessage[]
            {
                new SystemChatMessage(ExplainPrompt),
                new UserChatMessage($"Setup: \"{joke.Setup}\"\nPunchline: \"{joke.Punchline}\"")
            };

            var response = await chat.CompleteChatAsync(messages, cancellationToken: cts.Token);

            if (response.Value.FinishReason == ChatFinishReason.ContentFilter)
                return "The Royal Censor has deemed this joke's mechanism too dangerous to explain.";

            return response.Value.Content[0].Text.Trim();
        }
        catch (OperationCanceledException)
        {
            _logger.LogWarning("Joke explanation timeout for {JokeId}", joke.Id);
            return "The Comedy Scholar fell asleep before finishing the explanation.";
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Joke explanation failed for {JokeId}", joke.Id);
            return "The Comedy Scholar's notes were lost in a fire.";
        }
    }

    // ── Similarity scoring (Levenshtein + Jaccard blend) ─────────────────────
    private static double CalculateSimilarity(string actual, string predicted)
    {
        if (string.IsNullOrWhiteSpace(actual) || string.IsNullOrWhiteSpace(predicted))
            return 0;

        var actualLower = actual.ToLowerInvariant();
        var predictedLower = predicted.ToLowerInvariant();

        if (actualLower == predictedLower)
            return 1.0;

        var levenshteinSimilarity = LevenshteinSimilarity(actualLower, predictedLower);

        var separators = new[] { ' ', '.', '!', '?', ',' };
        var actualWords = actualLower.Split(separators, StringSplitOptions.RemoveEmptyEntries).ToHashSet();
        var predictedWords = predictedLower.Split(separators, StringSplitOptions.RemoveEmptyEntries).ToHashSet();

        double jaccardSimilarity = 0;
        if (actualWords.Count > 0 && predictedWords.Count > 0)
        {
            var intersection = actualWords.Intersect(predictedWords).Count();
            var union = actualWords.Union(predictedWords).Count();
            jaccardSimilarity = (double)intersection / union;
        }

        return (levenshteinSimilarity * 0.55) + (jaccardSimilarity * 0.45);
    }

    private static double LevenshteinSimilarity(string s1, string s2)
    {
        int maxLength = Math.Max(s1.Length, s2.Length);
        if (maxLength == 0)
            return 1.0;
        return 1.0 - ((double)LevenshteinDistance(s1, s2) / maxLength);
    }

    private static int LevenshteinDistance(string s1, string s2)
    {
        int[,] dp = new int[s1.Length + 1, s2.Length + 1];
        for (int i = 0; i <= s1.Length; i++) dp[i, 0] = i;
        for (int j = 0; j <= s2.Length; j++) dp[0, j] = j;

        for (int i = 1; i <= s1.Length; i++)
        {
            for (int j = 1; j <= s2.Length; j++)
            {
                if (s1[i - 1] == s2[j - 1])
                    dp[i, j] = dp[i - 1, j - 1];
                else
                    dp[i, j] = 1 + Math.Min(Math.Min(dp[i - 1, j], dp[i, j - 1]), dp[i - 1, j - 1]);
            }
        }
        return dp[s1.Length, s2.Length];
    }

    private static double? ExtractScore(string text, string key)
    {
        foreach (var line in text.Split('\n'))
        {
            if (line.ToLowerInvariant().Contains(key))
            {
                var parts = line.Split(':');
                if (parts.Length > 1 && double.TryParse(parts[1].Trim(), out var score))
                {
                    return Math.Clamp(score, 0, 1);
                }
            }
        }
        return null;
    }
}
