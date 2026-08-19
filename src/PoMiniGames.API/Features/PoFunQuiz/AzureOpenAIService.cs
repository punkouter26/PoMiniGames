using System.Text.Json;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// Server-side Azure OpenAI question generator for PoFunQuiz. Backed by the shared
/// Azure AI Foundry hub in the <c>PoShared</c> resource group; the <c>funquiz</c>
/// deployment is resolved through <see cref="AIFoundryOptions"/>.
///
/// <para><b>Mock fallback</b>: gated on <c>IsDevelopment() || IsEnvironment("Test")</c>
/// AND the explicit <c>UseMockAI</c> flag. In Production, missing config causes an
/// <see cref="InvalidOperationException"/> on first call rather than silently serving
/// fabricated data — see the 2026-06-13 mock-data fix (user memory
/// <c>pofunquiz-mock-data-fix.md</c>).</para>
/// </summary>
/// <remarks>
/// <para>
/// <b>Chat client.</b> Resolved from the keyed <see cref="IChatClient"/> registration, not from
/// <c>AIFoundryChatClientCache</c>. Going to the cache handed back a bare SDK <c>ChatClient</c>,
/// which meant this game — like PoCoupleQuiz and PoJoker — ran with no resilience pipeline, no
/// circuit breaker, no concurrency limit, no token accounting and no health tracking. Every
/// cross-cutting guarantee the AI layer documents was, for this service, not in the call path at all.
/// </para>
/// <para>
/// <b>Output contract.</b> The reply is schema-constrained where the deployment supports it
/// (see <see cref="AiModelCapabilities"/>), so <c>correctOptionIndex</c> arrives as an integer in
/// range and <c>difficulty</c> as one of three known strings, rather than being hoped for from a
/// JSON-object-mode reply and silently dropped by the parser when it was not.
/// </para>
/// </remarks>
public sealed class AzureOpenAIService : IOpenAIService
{
    /// <summary>
    /// Output ceiling for a generation call, scaled by how many questions were asked for.
    /// </summary>
    /// <remarks>
    /// A fixed cap cannot work across a request range of 1–50 questions: sized for 50 it is a
    /// blank cheque for a request of 3, and sized for 3 it truncates a request for 50 into an
    /// unparseable reply. ~90 tokens per question plus headroom for the envelope, measured against
    /// four-option questions with a difficulty label.
    /// </remarks>
    private const int TokensPerQuestion = 90;
    private const int EnvelopeTokens = 200;

    /// <summary>Hard cap on questions per call, mirrored by the endpoint's own guard.</summary>
    public const int MaxQuestionsPerCall = 50;

    private readonly IConfiguration _configuration;
    private readonly IHostEnvironment _environment;
    private readonly ILogger<AzureOpenAIService> _logger;
    private readonly GameChatClientFactory _clients;
    private readonly IOptionsMonitor<AIFoundryOptions> _foundryOptions;

    public AzureOpenAIService(
        IConfiguration configuration,
        IHostEnvironment environment,
        ILogger<AzureOpenAIService> logger,
        GameChatClientFactory clients,
        IOptionsMonitor<AIFoundryOptions> foundryOptions)
    {
        _configuration = configuration;
        _environment = environment;
        _logger = logger;
        _clients = clients;
        _foundryOptions = foundryOptions;
    }

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<QuestionCategory, List<QuizQuestion>> QuestionPoolCache = new();

    public async Task<IReadOnlyList<QuizQuestion>> GenerateQuizQuestionsAsync(
        QuestionCategory category, int count, CancellationToken cancellationToken = default)
    {
        if (count <= 0) return Array.Empty<QuizQuestion>();
        count = Math.Min(count, MaxQuestionsPerCall); // hard cap

        // Fast path: check warm semantic question cache pool
        if (QuestionPoolCache.TryGetValue(category, out var pool) && pool.Count >= count)
        {
            lock (pool)
            {
                if (pool.Count >= count)
                {
                    var shuffled = pool.OrderBy(_ => Random.Shared.Next()).Take(count).ToList();
                    return shuffled;
                }
            }
        }

        var useMock = _configuration.GetValue<bool>("PoFunQuiz:Features:UseMockAI");
        if (useMock && IsNonProduction())
        {
            _logger.MockEnabled(_environment.EnvironmentName);
            var mockQuestions = MockOpenAIService.GenerateQuestions(category, count);
            QuestionPoolCache.AddOrUpdate(category, _ => new List<QuizQuestion>(mockQuestions), (_, existing) => { lock (existing) { existing.AddRange(mockQuestions); } return existing; });
            return mockQuestions;
        }

        var deployment = _clients.DeploymentFor(AIFoundryOptions.Games.FunQuiz);
        var chatClient = _foundryOptions.CurrentValue.IsConfigured
            ? _clients.ForDeployment(AIFoundryOptions.Games.FunQuiz, deployment)
            : null;

        if (chatClient is null)
        {
            if (IsNonProduction())
            {
                _logger.NotConfigured(_environment.EnvironmentName);
                return MockOpenAIService.GenerateQuestions(category, count);
            }
            throw new InvalidOperationException(
                $"PoFunQuiz: AIFoundry not configured. Set {AIFoundryOptions.SectionName} in Key Vault (kv-poshared).");
        }

        // Batch pre-generation to minimize total cloud calls
        var batchCount = Math.Max(count, 12);
        var systemPrompt =
            "You generate multiple-choice trivia questions. Every question has exactly 4 options and " +
            "exactly one correct answer, identified by its zero-based index. Vary difficulty across " +
            "Easy, Medium and Hard unless asked otherwise. Do not repeat a question within one response. " +
            "No explanations, no commentary — emit only the JSON object described by the schema: " +
            "{\"questions\":[{\"text\":\"<q>\",\"options\":[\"a\",\"b\",\"c\",\"d\"]," +
            "\"correctOptionIndex\":<0-3>,\"difficulty\":\"Easy|Medium|Hard\"}]}.";

        // The category is one of our own enum values, not user text, so it needs no fencing.
        var userPrompt = $"Generate {batchCount} trivia questions in the category: {category}.";

        try
        {
            var messages = new List<ChatMessage>
            {
                new(ChatRole.System, systemPrompt),
                new(ChatRole.User, userPrompt),
            };

            var options = AiDecisionChatOptions.ForStructuredJson(
                QuestionsSchema,
                schemaName: "quiz_questions",
                maxOutputTokens: EnvelopeTokens + (batchCount * TokensPerQuestion),
                deployment: deployment,
                schemaDescription: "A batch of four-option multiple-choice trivia questions.",
                capabilityOverrides: _clients.CapabilityOverrides);

            var response = await chatClient.GetResponseAsync(messages, options, cancellationToken);
            var parsed = ParseQuestions(response.Text, category, batchCount, _logger);
            if (parsed.Count > 0)
            {
                QuestionPoolCache.AddOrUpdate(category, _ => new List<QuizQuestion>(parsed), (_, existing) => { lock (existing) { existing.AddRange(parsed); } return existing; });
            }
            return parsed.Take(count).ToList();
        }
        catch (Exception ex)
        {
            _logger.GenerationFailed(ex, category, count);
            if (IsNonProduction()) return MockOpenAIService.GenerateQuestions(category, count);
            throw;
        }
    }

    /// <summary>
    /// The reply contract as a schema the service enforces. <c>correctOptionIndex</c> is bounded
    /// and <c>difficulty</c> is an enum, which is what stops a malformed item from being silently
    /// dropped by the parser below and the caller quietly receiving fewer questions than it asked for.
    /// </summary>
    /// <remarks>
    /// <c>.Clone()</c> is load-bearing — a <see cref="JsonElement"/> is a view over its
    /// <see cref="JsonDocument"/>'s pooled buffer, and handing out the un-cloned root of a document
    /// nobody holds throws once that document is collected.
    /// </remarks>
    public static JsonElement QuestionsSchema { get; } = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "questions": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "text": { "type": "string" },
                  "options": {
                    "type": "array",
                    "items": { "type": "string" },
                    "minItems": 4,
                    "maxItems": 4
                  },
                  "correctOptionIndex": { "type": "integer", "minimum": 0, "maximum": 3 },
                  "difficulty": { "type": "string", "enum": ["Easy", "Medium", "Hard"] }
                },
                "required": ["text", "options", "correctOptionIndex", "difficulty"],
                "additionalProperties": false
              }
            }
          },
          "required": ["questions"],
          "additionalProperties": false
        }
        """).RootElement.Clone();

    /// <summary>
    /// Parses the reply into questions. Throws <see cref="QuizGenerationUnusableException"/> when
    /// nothing usable came back.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This used to end with <c>if (results.Count == 0) return MockOpenAIService.GenerateQuestions(...)</c>
    /// — unconditionally, in every environment. So a Production deployment that returned unparseable
    /// JSON served players a fixed pool of hardcoded questions that looked exactly like real output,
    /// which is precisely the failure the class's own "never silently serves fabricated data" contract
    /// was written to prevent. The mock decision belongs to the caller, which knows the environment;
    /// a parser's job is to report that it parsed nothing.
    /// </para>
    /// <para>
    /// The surrounding <c>catch</c> also swallowed the <see cref="JsonException"/> without logging,
    /// so the one signal that would have identified the cause was discarded too.
    /// </para>
    /// <para>
    /// Still tolerant of prose around the JSON: the schema makes that unnecessary for a compliant
    /// provider, but the JSON-object-mode fallback (used by deployments without schema support)
    /// can still produce it.
    /// </para>
    /// </remarks>
    private static IReadOnlyList<QuizQuestion> ParseQuestions(
        string? raw, QuestionCategory category, int expected, ILogger logger)
    {
        var start = raw?.IndexOf('{') ?? -1;
        var end = raw?.LastIndexOf('}') ?? -1;
        if (raw is null || start < 0 || end <= start)
        {
            logger.UnparseableReply("PoFunQuiz", "no JSON object in the reply", Truncate(raw, 300));
            throw new QuizGenerationUnusableException(raw?.Length ?? 0, expected);
        }

        var results = new List<QuizQuestion>();
        var rejected = 0;
        try
        {
            using var doc = JsonDocument.Parse(raw[start..(end + 1)]);

            var array = doc.RootElement.TryGetProperty("questions", out var q)
                ? q
                : doc.RootElement;

            if (array.ValueKind != JsonValueKind.Array)
            {
                logger.UnparseableReply("PoFunQuiz", "reply carried no questions array", Truncate(raw, 300));
                throw new QuizGenerationUnusableException(raw.Length, expected);
            }

            foreach (var item in array.EnumerateArray())
            {
                if (TryReadQuestion(item, category) is { } question)
                    results.Add(question);
                else
                    rejected++;
            }
        }
        catch (JsonException ex)
        {
            logger.UnparseableReply("PoFunQuiz", $"invalid JSON ({ex.Message})", Truncate(raw, 300));
            throw new QuizGenerationUnusableException(raw.Length, expected);
        }

        if (results.Count == 0)
        {
            logger.UnparseableReply(
                "PoFunQuiz", $"every one of {rejected} item(s) failed validation", Truncate(raw, 300));
            throw new QuizGenerationUnusableException(raw.Length, expected);
        }

        if (rejected > 0)
        {
            // A partial batch is served rather than failed — the game can run on fewer questions —
            // but silently returning less than was asked for is how a slow degradation goes unnoticed.
            logger.PartialQuestionBatch(results.Count, expected, rejected);
        }

        return results;
    }

    /// <summary>Reads one question, or null when it does not satisfy the game's invariants.</summary>
    private static QuizQuestion? TryReadQuestion(JsonElement item, QuestionCategory category)
    {
        if (item.ValueKind != JsonValueKind.Object
            || !item.TryGetProperty("text", out var textEl)
            || textEl.ValueKind != JsonValueKind.String
            || !item.TryGetProperty("options", out var optionsEl)
            || optionsEl.ValueKind != JsonValueKind.Array
            || !item.TryGetProperty("correctOptionIndex", out var correctEl)
            || !correctEl.TryGetInt32(out var correct))
        {
            return null;
        }

        var text = textEl.GetString();
        if (string.IsNullOrWhiteSpace(text)) return null;

        var options = new List<string>(4);
        foreach (var option in optionsEl.EnumerateArray())
        {
            if (option.ValueKind != JsonValueKind.String) return null;
            var value = option.GetString();
            if (string.IsNullOrWhiteSpace(value)) return null;
            options.Add(value);
        }

        if (options.Count != 4 || correct < 0 || correct > 3) return null;

        var difficulty =
            item.TryGetProperty("difficulty", out var d)
            && d.ValueKind == JsonValueKind.String
            && Enum.TryParse<DifficultyLevel>(d.GetString(), ignoreCase: true, out var parsed)
                ? parsed
                : DifficultyLevel.Medium;

        return new QuizQuestion
        {
            Text = text,
            Options = options,
            CorrectOptionIndex = correct,
            Category = category,
            Difficulty = difficulty,
        };
    }

    private static string Truncate(string? text, int max)
        => string.IsNullOrEmpty(text) ? "(empty)"
         : text.Length <= max ? text
         : text[..max] + "…";

    private bool IsNonProduction() => _environment.IsDevelopment() || _environment.IsEnvironment("Test");
}

/// <summary>
/// Thrown when the model answered but the reply contained no usable question. Distinct from a
/// transport failure so the caller can decide what to do about it — which, in Production, is
/// surface the failure, not substitute fabricated questions.
/// </summary>
public sealed class QuizGenerationUnusableException : Exception
{
    public QuizGenerationUnusableException(int rawLength, int requested)
        : base($"The model returned no usable questions (rawLength={rawLength}, requested={requested}).")
    {
        RawLength = rawLength;
        Requested = requested;
    }

    /// <summary>Length of the reply. Zero means the output budget was spent before any text.</summary>
    public int RawLength { get; }

    /// <summary>How many questions were asked for.</summary>
    public int Requested { get; }
}

/// <summary>
/// Deterministic in-memory question generator used when <c>UseMockAI=true</c>
/// (Dev/Test only). Each category has a fixed pool of well-known facts.
/// </summary>
public static class MockOpenAIService
{
    private static readonly Dictionary<QuestionCategory, (string q, string[] opts, int correct, DifficultyLevel diff)[]> Pool = new()
    {
        [QuestionCategory.Science] = new[]
        {
            ( "What is H₂O?", new[] {"Salt", "Water", "Hydrogen peroxide", "Ammonia"}, 1, DifficultyLevel.Easy ),
            ( "What planet is known as the Red Planet?", new[] {"Venus", "Mars", "Jupiter", "Saturn"}, 1, DifficultyLevel.Easy ),
            ( "What gas do plants absorb for photosynthesis?", new[] {"Oxygen", "Nitrogen", "Carbon dioxide", "Helium"}, 2, DifficultyLevel.Easy ),
            ( "What is the speed of light in a vacuum (m/s, approx)?", new[] {"3×10⁵", "3×10⁶", "3×10⁸", "3×10¹⁰"}, 2, DifficultyLevel.Medium ),
            ( "Who proposed the theory of general relativity?", new[] {"Newton", "Einstein", "Bohr", "Hawking"}, 1, DifficultyLevel.Medium ),
            ( "What particle has no electric charge?", new[] {"Electron", "Proton", "Neutron", "Muon"}, 2, DifficultyLevel.Medium ),
        },
        [QuestionCategory.History] = new[]
        {
            ( "In which year did World War II end?", new[] {"1943", "1944", "1945", "1946"}, 2, DifficultyLevel.Easy ),
            ( "Who was the first President of the United States?", new[] {"Adams", "Jefferson", "Washington", "Madison"}, 2, DifficultyLevel.Easy ),
            ( "The Berlin Wall fell in which year?", new[] {"1987", "1989", "1991", "1993"}, 1, DifficultyLevel.Medium ),
            ( "Which empire was ruled by Julius Caesar?", new[] {"Greek", "Roman", "Ottoman", "Byzantine"}, 1, DifficultyLevel.Medium ),
        },
        [QuestionCategory.Geography] = new[]
        {
            ( "What is the capital of Australia?", new[] {"Sydney", "Melbourne", "Canberra", "Perth"}, 2, DifficultyLevel.Medium ),
            ( "Which is the longest river in the world?", new[] {"Amazon", "Nile", "Yangtze", "Mississippi"}, 1, DifficultyLevel.Medium ),
            ( "Mount Everest is on the border of Nepal and which other country?", new[] {"India", "China", "Bhutan", "Pakistan"}, 1, DifficultyLevel.Medium ),
        },
        [QuestionCategory.Sports] = new[]
        {
            ( "How many players are on a standard soccer team on the field?", new[] {"9", "10", "11", "12"}, 2, DifficultyLevel.Easy ),
            ( "In which sport is the term 'birdie' used?", new[] {"Tennis", "Golf", "Cricket", "Hockey"}, 1, DifficultyLevel.Easy ),
            ( "The Tour de France is held primarily in which country?", new[] {"Italy", "Spain", "France", "Belgium"}, 2, DifficultyLevel.Easy ),
        },
        [QuestionCategory.Entertainment] = new[]
        {
            ( "Who painted the Mona Lisa?", new[] {"Michelangelo", "Da Vinci", "Raphael", "Donatello"}, 1, DifficultyLevel.Easy ),
            ( "What is the highest-grossing film of all time (unadjusted)?", new[] {"Avatar", "Avengers: Endgame", "Titanic", "Star Wars"}, 0, DifficultyLevel.Medium ),
        },
        [QuestionCategory.Technology] = new[]
        {
            ( "What does CPU stand for?", new[] {"Computer Personal Unit", "Central Processing Unit", "Central Program Utility", "Core Processing Unit"}, 1, DifficultyLevel.Easy ),
            ( "Who is the co-founder of Microsoft alongside Bill Gates?", new[] {"Steve Jobs", "Paul Allen", "Larry Page", "Mark Zuckerberg"}, 1, DifficultyLevel.Medium ),
        },
        [QuestionCategory.ArtCulture] = new[]
        {
            ( "The 'Starry Night' was painted by whom?", new[] {"Monet", "Van Gogh", "Cézanne", "Renoir"}, 1, DifficultyLevel.Easy ),
            ( "Shakespeare wrote 'Romeo and Juliet'. What type of work is it?", new[] {"Novel", "Tragedy", "Comedy", "Sonnet"}, 1, DifficultyLevel.Medium ),
        },
        [QuestionCategory.General] = new[]
        {
            ( "How many continents are there?", new[] {"5", "6", "7", "8"}, 2, DifficultyLevel.Easy ),
            ( "What is the largest ocean?", new[] {"Atlantic", "Indian", "Arctic", "Pacific"}, 3, DifficultyLevel.Easy ),
        },
    };

    public static IReadOnlyList<QuizQuestion> GenerateQuestions(QuestionCategory category, int count)
    {
        var pool = Pool.TryGetValue(category, out var p) ? p : Pool[QuestionCategory.General];
        var list = new List<QuizQuestion>(count);
        for (var i = 0; i < count; i++)
        {
            var (text, opts, correct, diff) = pool[i % pool.Length];
            list.Add(new QuizQuestion
            {
                Text = text,
                Options = new List<string>(opts),
                CorrectOptionIndex = correct,
                Category = category,
                Difficulty = diff
            });
        }
        return list;
    }
}
