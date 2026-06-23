using System.ClientModel;
using System.Text.Json;
using Azure;
using Azure.AI.OpenAI;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpenAI.Chat;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// Server-side Azure OpenAI question generator for PoFunQuiz. Backed by the shared
/// <c>po-aiservices-shared</c> gpt-5-nano deployment.
///
/// <para><b>Mock fallback</b>: gated on <c>IsDevelopment() || IsEnvironment("Test")</c>
/// AND the explicit <c>UseMockAI</c> flag. In Production, missing config causes an
/// <see cref="InvalidOperationException"/> on first call rather than silently serving
/// fabricated data — see the 2026-06-13 mock-data fix (user memory
/// <c>pofunquiz-mock-data-fix.md</c>).</para>
/// </summary>
public sealed class AzureOpenAIService : IOpenAIService
{
    private readonly IConfiguration _configuration;
    private readonly IHostEnvironment _environment;
    private readonly ILogger<AzureOpenAIService> _logger;
    private readonly Lazy<ChatClient?> _chatClient;
    private readonly string? _configErrorMessage;

    public AzureOpenAIService(
        IConfiguration configuration,
        IHostEnvironment environment,
        ILogger<AzureOpenAIService> logger)
    {
        _configuration = configuration;
        _environment = environment;
        _logger = logger;

        var endpoint = configuration["PoFunQuiz:AzureOpenAI:Endpoint"];
        var apiKey = configuration["PoFunQuiz:AzureOpenAI:ApiKey"];
        var deploymentName = configuration["PoFunQuiz:AzureOpenAI:DeploymentName"];

        if (string.IsNullOrWhiteSpace(endpoint) || string.IsNullOrWhiteSpace(apiKey) || string.IsNullOrWhiteSpace(deploymentName))
        {
            _configErrorMessage = "PoFunQuiz:AzureOpenAI:Endpoint/ApiKey/DeploymentName are not configured.";
            _chatClient = new Lazy<ChatClient?>(() => null);
            return;
        }

        var client = new AzureOpenAIClient(new Uri(endpoint), new AzureKeyCredential(apiKey));
        _chatClient = new Lazy<ChatClient?>(() => client.GetChatClient(deploymentName));
    }

    public async Task<IReadOnlyList<QuizQuestion>> GenerateQuizQuestionsAsync(
        QuestionCategory category, int count, CancellationToken cancellationToken = default)
    {
        if (count <= 0) return Array.Empty<QuizQuestion>();
        count = Math.Min(count, 50); // hard cap

        var useMock = _configuration.GetValue<bool>("PoFunQuiz:Features:UseMockAI");
        if (useMock && IsNonProduction())
        {
            _logger.LogWarning("PoFunQuiz: UseMockAI=true in {Environment}; serving mock questions.", _environment.EnvironmentName);
            return MockOpenAIService.GenerateQuestions(category, count);
        }

        if (_chatClient.Value is null)
        {
            if (IsNonProduction())
            {
                _logger.LogWarning("PoFunQuiz: Azure OpenAI not configured; serving mock questions in {Environment}.", _environment.EnvironmentName);
                return MockOpenAIService.GenerateQuestions(category, count);
            }
            throw new InvalidOperationException(_configErrorMessage);
        }

        var systemPrompt = "You generate multiple-choice trivia questions. Respond with a JSON object: " +
                           "{\"questions\":[{\"text\":\"<q>\",\"options\":[\"a\",\"b\",\"c\",\"d\"],\"correctOptionIndex\":<0-3>,\"difficulty\":\"Easy|Medium|Hard\"}]}. " +
                           "No explanations. Exactly 4 options per question. Difficulty is a mix unless asked otherwise.";
        var userPrompt = $"Generate {count} {category} trivia questions. Mix Easy/Medium/Hard.";

        try
        {
            var messages = new List<ChatMessage>
            {
                new SystemChatMessage(systemPrompt),
                new UserChatMessage(userPrompt)
            };
            var options = new ChatCompletionOptions { ResponseFormat = ChatResponseFormat.CreateJsonObjectFormat() };
            var completion = await _chatClient.Value.CompleteChatAsync(messages, options, cancellationToken);
            var json = completion.Value.Content[0].Text;
            return ParseQuestions(json, category, count);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "PoFunQuiz: Azure OpenAI question generation failed.");
            if (IsNonProduction()) return MockOpenAIService.GenerateQuestions(category, count);
            throw;
        }
    }

    private static IReadOnlyList<QuizQuestion> ParseQuestions(string json, QuestionCategory category, int expected)
    {
        var results = new List<QuizQuestion>();
        try
        {
            using var doc = JsonDocument.Parse(json);
            JsonElement array;
            if (doc.RootElement.TryGetProperty("questions", out var q))
                array = q;
            else if (doc.RootElement.ValueKind == JsonValueKind.Array)
                array = doc.RootElement;
            else
                array = doc.RootElement; // single object fallback

            foreach (var item in array.EnumerateArray())
            {
                var text = item.GetProperty("text").GetString() ?? string.Empty;
                var options = item.GetProperty("options").EnumerateArray().Select(o => o.GetString() ?? "").ToList();
                var correct = item.GetProperty("correctOptionIndex").GetInt32();
                var diff = item.TryGetProperty("difficulty", out var d) && Enum.TryParse<DifficultyLevel>(d.GetString(), true, out var dval)
                    ? dval
                    : DifficultyLevel.Medium;
                if (options.Count != 4 || correct < 0 || correct > 3) continue;
                results.Add(new QuizQuestion
                {
                    Text = text,
                    Options = options,
                    CorrectOptionIndex = correct,
                    Category = category,
                    Difficulty = diff
                });
            }
        }
        catch
        {
            // JSON parse failure — return whatever we have (possibly empty).
        }
        if (results.Count == 0)
        {
            return MockOpenAIService.GenerateQuestions(category, expected);
        }
        return results;
    }

    private bool IsNonProduction() => _environment.IsDevelopment() || _environment.IsEnvironment("Test");
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
