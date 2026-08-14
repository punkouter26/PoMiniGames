using System.Text.Json;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Caching.Hybrid;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using PoMiniGames.Shared.Games.PoJoker;

namespace PoMiniGames.Features.PoJoker;

/// <summary>
/// AI-powered joke analysis service backed by the centralized Azure AI Foundry hub
/// in the <c>PoShared</c> resource group. The <c>joker</c> deployment is resolved
/// through <see cref="AIFoundryOptions"/>.
///
/// <para><b>Mock fallback</b> follows the PoCoupleQuiz pattern: when the foundry is
/// not configured, the service falls back to <see cref="MockAnalysisService"/> in
/// non-Production environments and throws in Production (so a misconfigured deployment
/// never silently serves fabricated data).</para>
/// </summary>
/// <remarks>
/// <para>
/// <b>Chat client.</b> From <see cref="GameChatClientFactory"/>, not the bare
/// <c>AIFoundryChatClientCache</c>. The cache returns an undecorated SDK client, so until now this
/// service — the most call-hungry of the four, running an autonomous show loop — had no resilience
/// pipeline, no circuit breaker, no concurrency limiter, no spend ceiling and no telemetry. The
/// class comment claimed "the shared AzureOpenAIResilience options bound the per-attempt network
/// timeout and retry count", which was true only of the SDK-level options; the orchestrating
/// pipeline was not in the path.
/// </para>
/// <para>
/// <b>Two tasks, two models.</b> Predicting a punchline is a creative job; scoring three numbers
/// between 0 and 1 is not. They resolve separate deployments (<c>joker</c> and
/// <c>joker.rating</c>), so the cheap half can be moved to a cheap model in configuration alone.
/// </para>
/// </remarks>
public sealed class AiJesterService : IAnalysisService
{
    /// <summary>Output ceiling for a predicted punchline. It is one line by contract.</summary>
    private const int PunchlineMaxTokens = 120;

    /// <summary>Output ceiling for a rating. Three numbers and a one-word emotion slug.</summary>
    private const int RatingMaxTokens = 110;

    /// <summary>Output ceiling for an explanation. Two sentences by contract.</summary>
    private const int ExplanationMaxTokens = 250;

    private readonly ILogger<AiJesterService> _logger;
    private readonly IHostEnvironment _environment;
    private readonly MockAnalysisService _mock;
    private readonly GameChatClientFactory _clients;
    private readonly IOptionsMonitor<AIFoundryOptions> _foundryOptions;
    private readonly HybridCache _cache;
    private readonly int _timeoutSeconds;

    private const string SystemPrompt = """
        You are a Digital Jester - an AI that tries to predict punchlines to jokes.
        Given a joke setup, you must predict what the punchline will be.
        Be creative and funny, but try to guess the actual punchline.
        Respond with ONLY the punchline, nothing else. No explanations, no "I think", just the punchline itself.
        Keep your response short and punchy.
        """ + "\n" + AiPrompt.FencingInstruction;

    public AiJesterService(
        IConfiguration configuration,
        IHostEnvironment environment,
        MockAnalysisService mock,
        ILogger<AiJesterService> logger,
        GameChatClientFactory clients,
        IOptionsMonitor<AIFoundryOptions> foundryOptions,
        HybridCache cache)
    {
        _logger = logger;
        _environment = environment;
        _mock = mock;
        _clients = clients;
        _foundryOptions = foundryOptions;
        _cache = cache;
        _timeoutSeconds = configuration.GetValue("PoJoker:AzureOpenAI:TimeoutSeconds", 30);
    }

    private bool IsNonProduction() => _environment.IsDevelopment() || _environment.IsEnvironment("Test");

    /// <summary>The decorated client for a key, or null when the foundry is unconfigured.</summary>
    private IChatClient? ResolveClient(string key)
        => _foundryOptions.CurrentValue.IsConfigured
            ? _clients.ForDeployment(key, _clients.DeploymentFor(key))
            : null;

    public async Task<(JokeAnalysisDto Analysis, JokeRatingDto Rating)> AnalyzeJokeAsync(
        JokeDto joke, CancellationToken cancellationToken = default)
    {
        if (ResolveClient(AIFoundryOptions.Games.Joker) is null)
        {
            if (IsNonProduction())
            {
                _logger.LogWarning("PoJoker: AIFoundry not configured; serving mock analysis in {Environment}.", _environment.EnvironmentName);
                return await _mock.AnalyzeJokeAsync(joke, cancellationToken);
            }
            throw new InvalidOperationException(
                $"PoJoker: AIFoundry not configured. Set {AIFoundryOptions.SectionName} in Key Vault (kv-poshared).");
        }

        // Still concurrent, but now behind the game's own concurrency partition rather than
        // unbounded. Two calls per joke against an account measured to complete one of three
        // concurrent requests is exactly what the limiter exists to convert into "slightly slower"
        // instead of "mostly lost" — before, nothing was queueing these at all.
        var analysisTask = PredictPunchlineAsync(joke, cancellationToken);
        var ratingTask = RateJokeAsync(joke, cancellationToken);
        await Task.WhenAll(analysisTask, ratingTask);
        return (analysisTask.Result, ratingTask.Result);
    }

    private async Task<JokeAnalysisDto> PredictPunchlineAsync(JokeDto joke, CancellationToken cancellationToken)
    {
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();

        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(TimeSpan.FromSeconds(_timeoutSeconds));

            var deployment = _clients.DeploymentFor(AIFoundryOptions.Games.Joker);
            var chat = _clients.ForDeployment(AIFoundryOptions.Games.Joker, deployment)!;

            var messages = new List<ChatMessage>
            {
                new(ChatRole.System, SystemPrompt),
                // Third-party text from jokeapi.dev: fenced so a joke body carrying an instruction
                // is read as the setup it claims to be.
                new(ChatRole.User, AiPrompt.Fence(joke.Setup, "Joke setup")),
            };

            var response = await chat.GetResponseAsync(
                messages,
                AiDecisionChatOptions.ForBoundedText(PunchlineMaxTokens, deployment, _clients.CapabilityOverrides),
                cts.Token);

            var filtered = WasContentFiltered(response);
            var aiPunchline = filtered
                ? "[The Jester shrugs and delivers a safe, court-approved punchline.]"
                : (response.Text ?? string.Empty).Trim();

            if (!filtered && string.IsNullOrWhiteSpace(aiPunchline))
            {
                // An empty completion is a provider problem (typically the output budget consumed
                // by reasoning tokens), not the Jester having nothing to say. Say which.
                _logger.LogWarning(
                    "PoJoker: punchline prediction for joke {JokeId} returned an empty completion.", joke.Id);
                aiPunchline = "[The Jester opened his mouth and nothing came out.]";
            }

            stopwatch.Stop();
            var similarityScore = filtered ? 0.0 : CalculateSimilarity(joke.Punchline, aiPunchline);
            var isTriumph = similarityScore >= 0.55 && !filtered;

            _logger.LogInformation(
                "AI predicted punchline for joke {JokeId}: Similarity={Similarity:P1}, IsTriumph={IsTriumph}, LatencyMs={LatencyMs}",
                joke.Id, similarityScore, isTriumph, stopwatch.ElapsedMilliseconds);

            return new JokeAnalysisDto
            {
                OriginalJoke = joke,
                AiPunchline = aiPunchline,
                Confidence = filtered ? 0.5 : 0.9,
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

    /// <summary>
    /// Rates a joke on originality, cleverness and humour.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Memoized on the joke's content. A rating is a pure function of the joke — the same setup and
    /// punchline deserve the same score — and PoJoker's show loop re-fetches from a finite upstream
    /// catalogue, so the same joke recurs. Re-rating it is spend for an answer already known.
    /// </para>
    /// <para>
    /// The reply is a schema-constrained object where the deployment supports one. It used to be
    /// three lines of <c>originality: 0.X</c> text recovered by <c>ExtractScore</c>, which scanned
    /// for any line <em>containing</em> the key — so a model that prefixed its answer with a
    /// sentence mentioning "cleverness" scored from that sentence.
    /// </para>
    /// </remarks>
    private async Task<JokeRatingDto> RateJokeAsync(JokeDto joke, CancellationToken cancellationToken)
    {
        var cacheKey = $"pojoker:rating:{Hash(joke.Setup, joke.Punchline)}";
        // Identity in the state: a HybridCache factory does not inherit the caller's
        // ExecutionContext, so an ambient scope is invisible inside it. See AiUsageScope.Restore.
        var identity = AiUsageScope.CurrentIdentity;
        try
        {
            return await _cache.GetOrCreateAsync(
                cacheKey,
                (Service: this, joke, Identity: identity),
                static async (state, ct) =>
                {
                    using var scope = AiUsageScope.Restore(state.Identity);
                    return await state.Service.RateJokeUncachedAsync(state.joke, ct);
                },
                new HybridCacheEntryOptions { Expiration = TimeSpan.FromHours(24) },
                cancellationToken: cancellationToken);
        }
        catch (OperationCanceledException)
        {
            _logger.LogWarning("Joke rating timeout or cancelled for {JokeId} after {Timeout}s", joke.Id, _timeoutSeconds);
            return NeutralRating("Timed out during rating.");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Joke rating failed for {JokeId}", joke.Id);
            return NeutralRating("Error during rating.");
        }
    }

    private async ValueTask<JokeRatingDto> RateJokeUncachedAsync(JokeDto joke, CancellationToken cancellationToken)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(TimeSpan.FromSeconds(_timeoutSeconds));

        // The emotion rides on the rating call rather than getting one of its own: it is the same
        // pure function of the same joke text, so it caches on the same key and costs no extra
        // request. See RatingSchema for the vocabulary the model must answer from.
        var ratingPrompt =
            "You rate jokes. Score each dimension from 0.0 to 1.0:\n" +
            "- originality: how unique and creative the joke is\n" +
            "- cleverness: how smart or witty the wordplay is\n" +
            "- humor: how funny it is overall\n" +
            "Also pick 'emotion': the face an audience member would pull at this joke's SUBJECT " +
            "MATTER — what the joke is about, not how good it is. A joke about death is 'dying'; " +
            "about drinking, 'drunk'; a groan-worthy pun, 'eye-roll'; something crude, 'blushing' " +
            "or 'disgust'; a riddle, 'thinking'. Choose exactly one value from the schema's enum.\n" +
            "Emit only the JSON object described by the schema. " +
            AiPrompt.FencingInstruction;

        // Separate task key so the cheap half of PoJoker can run on a cheap deployment.
        var deployment = _clients.DeploymentFor(AIFoundryOptions.Tasks.JokerRating);
        var chat = _clients.ForDeployment(AIFoundryOptions.Tasks.JokerRating, deployment)
            ?? throw new InvalidOperationException(
                $"PoJoker: AIFoundry not configured. Set {AIFoundryOptions.SectionName} in Key Vault (kv-poshared).");

        var messages = new List<ChatMessage>
        {
            new(ChatRole.System, ratingPrompt),
            new(ChatRole.User, AiPrompt.FenceAll(("Setup", joke.Setup), ("Punchline", joke.Punchline))),
        };

        var response = await chat.GetResponseAsync(
            messages,
            AiDecisionChatOptions.ForStructuredJson(
                RatingSchema,
                schemaName: "joke_rating",
                maxOutputTokens: RatingMaxTokens,
                deployment: deployment,
                schemaDescription: "Originality, cleverness and humour scores from 0.0 to 1.0.",
                capabilityOverrides: _clients.CapabilityOverrides),
            cts.Token);

        if (WasContentFiltered(response))
        {
            _logger.LogWarning("Content filter triggered while rating joke {JokeId}; returning neutral scores", joke.Id);
            return NeutralRating("Rated by the Digital Jester's discerning wit. (Filtered)");
        }

        return ParseRating(response.Text, joke.Id, _logger);
    }

    /// <summary>
    /// Rating reply shape: three bounded numbers and one audience reaction.
    /// </summary>
    /// <remarks>
    /// The emotion enum is projected from <see cref="JokerEmotions.All"/> rather than written out
    /// here, so the model can only name a portrait that exists on disk. Spelling the list twice is
    /// how it would eventually come back with a reaction the client has no image for.
    /// </remarks>
    public static JsonElement RatingSchema { get; } = JsonDocument.Parse(
        $$"""
        {
          "type": "object",
          "properties": {
            "originality": { "type": "number", "minimum": 0, "maximum": 1 },
            "cleverness":  { "type": "number", "minimum": 0, "maximum": 1 },
            "humor":       { "type": "number", "minimum": 0, "maximum": 1 },
            "emotion":     { "type": "string", "enum": [{{EmotionEnumJson}}] }
          },
          "required": ["originality", "cleverness", "humor", "emotion"],
          "additionalProperties": false
        }
        """).RootElement.Clone();

    /// <summary>
    /// The portrait vocabulary as a JSON string-array body (no brackets). Quoted by hand: every
    /// slug is lowercase ASCII with hyphens, so there is nothing for an escaper to do.
    /// </summary>
    private static string EmotionEnumJson =>
        string.Join(", ", JokerEmotions.All.Select(e => $"\"{e}\""));

    private static JokeRatingDto ParseRating(string? raw, int jokeId, ILogger logger)
    {
        using var doc = TryExtractJson(raw);
        if (doc is null)
        {
            logger.UnparseableReply("PoJoker", $"no JSON object in the rating for joke {jokeId}", Truncate(raw, 300));
            return NeutralRating("Rated by the Digital Jester's discerning wit.");
        }

        var root = doc.RootElement;

        // Every dimension must actually be present. Defaulting a missing one to 0.5 silently
        // produced a confident-looking 5/10 from a reply that contained no rating at all — measured
        // against Phi-4-mini-instruct, which answered this prompt with a verbatim echo of the joke
        // ({"setup":…,"punchline":…}) and was scored 5/5/5 with no warning anywhere. A rating that
        // cannot be read has to say so.
        if (TryReadScore(root, "cleverness") is not { } cleverness
            || TryReadScore(root, "originality") is not { } originality
            || TryReadScore(root, "humor") is not { } humor)
        {
            logger.UnparseableReply(
                "PoJoker",
                $"rating for joke {jokeId} carried no originality/cleverness/humor scores",
                Truncate(raw, 300));
            return NeutralRating("The Jester's scorecard came back blank.");
        }

        return new JokeRatingDto
        {
            // The DTO's fields do not line up with the prompt's dimensions by name; this mapping is
            // the one the game has always used (Complexity carries originality, Difficulty carries
            // humour) and is preserved deliberately so existing leaderboard rows stay comparable.
            Cleverness = ToTenPointScale(cleverness),
            Complexity = ToTenPointScale(originality),
            Difficulty = ToTenPointScale(humor),
            Rudeness = 1,
            Commentary = "Rated by the Digital Jester's discerning wit.",
            // Unlike the scores above, a missing or invented emotion is not grounds to discard the
            // rating — it only costs the audience one expressive frame. Normalize silently to
            // neutral rather than throwing away three scores the model got right.
            Emotion = JokerEmotions.Normalize(
                root.TryGetProperty("emotion", out var emotionEl) && emotionEl.ValueKind == JsonValueKind.String
                    ? emotionEl.GetString()
                    : null),
        };
    }

    /// <summary>The named score in [0,1], or null when the reply does not carry it as a number.</summary>
    private static double? TryReadScore(JsonElement root, string property)
        => root.TryGetProperty(property, out var el) && el.ValueKind == JsonValueKind.Number && el.TryGetDouble(out var d)
            ? Math.Clamp(d, 0, 1)
            : null;

    private static int ToTenPointScale(double value) => (int)Math.Round(value * 10);

    private static JokeRatingDto NeutralRating(string commentary) => new()
    {
        Cleverness = 5,
        Complexity = 5,
        Difficulty = 5,
        Rudeness = 1,
        Commentary = commentary,
    };

    private const string ExplainPrompt = """
        You are a comedy analyst. Given a joke's setup and punchline, write exactly 2 sentences:
        1. What expectation or misdirection the setup creates in the listener's mind.
        2. How the punchline subverts that expectation to produce the comedic effect.
        Be concise and insightful. Do not begin with "This joke" or repeat the joke text verbatim.
        """ + "\n" + AiPrompt.FencingInstruction;

    /// <summary>
    /// Explains a joke's mechanism. Memoized for the same reason ratings are: the explanation of a
    /// given joke does not change, and the Comedy Coach is invoked from a UI button players press
    /// more than once.
    /// </summary>
    public async Task<string> ExplainJokeAsync(JokeDto joke, CancellationToken cancellationToken = default)
    {
        if (ResolveClient(AIFoundryOptions.Games.Joker) is null)
        {
            if (IsNonProduction())
            {
                return await _mock.ExplainJokeAsync(joke, cancellationToken);
            }
            throw new InvalidOperationException(
                $"PoJoker: AIFoundry not configured. Set {AIFoundryOptions.SectionName} in Key Vault (kv-poshared).");
        }

        var identity = AiUsageScope.CurrentIdentity;
        try
        {
            return await _cache.GetOrCreateAsync(
                $"pojoker:explain:{Hash(joke.Setup, joke.Punchline)}",
                (Service: this, joke, Identity: identity),
                static async (state, ct) =>
                {
                    using var scope = AiUsageScope.Restore(state.Identity);
                    return await state.Service.ExplainUncachedAsync(state.joke, ct);
                },
                new HybridCacheEntryOptions { Expiration = TimeSpan.FromHours(24) },
                cancellationToken: cancellationToken);
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

    private async ValueTask<string> ExplainUncachedAsync(JokeDto joke, CancellationToken cancellationToken)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(TimeSpan.FromSeconds(_timeoutSeconds));

        var deployment = _clients.DeploymentFor(AIFoundryOptions.Games.Joker);
        var chat = _clients.ForDeployment(AIFoundryOptions.Games.Joker, deployment)!;

        var messages = new List<ChatMessage>
        {
            new(ChatRole.System, ExplainPrompt),
            new(ChatRole.User, AiPrompt.FenceAll(("Setup", joke.Setup), ("Punchline", joke.Punchline))),
        };

        var response = await chat.GetResponseAsync(
            messages,
            AiDecisionChatOptions.ForBoundedText(ExplanationMaxTokens, deployment, _clients.CapabilityOverrides),
            cts.Token);

        if (WasContentFiltered(response))
            return "The Royal Censor has deemed this joke's mechanism too dangerous to explain.";

        var text = (response.Text ?? string.Empty).Trim();
        return string.IsNullOrEmpty(text)
            ? "The Comedy Scholar stared at the page and wrote nothing."
            : text;
    }

    /// <summary>
    /// True when the provider stopped for its content filter.
    /// </summary>
    /// <remarks>
    /// <see cref="ChatFinishReason"/> is an extensible enum over the wire string, so this compares
    /// against the value rather than a member — the SDK-typed <c>ChatFinishReason.ContentFilter</c>
    /// check the previous implementation used is not reachable through the ME.AI abstraction.
    /// </remarks>
    private static bool WasContentFiltered(ChatResponse response)
        => response.FinishReason == ChatFinishReason.ContentFilter;

    /// <summary>Stable cache key component for a joke's content.</summary>
    private static string Hash(string? setup, string? punchline)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes($"{setup}{punchline}");
        return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes))[..32];
    }

    private static JsonDocument? TryExtractJson(string? raw)
    {
        var start = raw?.IndexOf('{') ?? -1;
        var end = raw?.LastIndexOf('}') ?? -1;
        if (raw is null || start < 0 || end <= start)
            return null;

        try
        {
            return JsonDocument.Parse(raw[start..(end + 1)]);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string Truncate(string? text, int max)
        => string.IsNullOrEmpty(text) ? "(empty)"
         : text.Length <= max ? text
         : text[..max] + "…";

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
}
