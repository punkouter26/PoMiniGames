using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// The free question source: <see href="https://opentdb.com">Open Trivia DB</see>. Its questions
/// are licensed CC BY-SA 4.0, which is why the quiz screen carries an attribution line.
/// </summary>
/// <remarks>
/// <para>
/// <b>Never throws.</b> An unreachable, slow or rate-limited API (OpenTDB allows one call per five
/// seconds per IP and answers <c>response_code 5</c> past that) returns an empty list; the caller
/// falls back to the bundled set and the bank.
/// </para>
/// <para>
/// <b>Shape.</b> Asked for <c>type=multiple</c> with the default HTML-entity encoding, so every
/// string goes through <see cref="WebUtility.HtmlDecode"/> (<c>&amp;quot;</c>, <c>&amp;#039;</c>,
/// <c>&amp;eacute;</c>). The correct answer arrives separately from the three wrong ones and is
/// shuffled in at a random index, then the whole item passes the same
/// <see cref="QuizQuality"/> gate the AI's output does.
/// </para>
/// </remarks>
public sealed class OpenTriviaDbClient
{
    public const string HttpClientName = "PoFunQuiz.OpenTriviaDb";

    /// <summary>The attribution the CC BY-SA licence asks for. Shown in the quiz footer.</summary>
    public const string Attribution = "Questions: Open Trivia DB (CC BY-SA 4.0)";

    /// <summary>OpenTDB's per-call maximum.</summary>
    public const int MaxPerCall = 50;

    /// <summary>
    /// OpenTDB category ids folded onto the game's eight categories. A fetch for one of ours picks
    /// one of its ids at random, so repeated top-ups spread across the sub-categories.
    /// </summary>
    internal static readonly IReadOnlyDictionary<QuestionCategory, int[]> CategoryIds =
        new Dictionary<QuestionCategory, int[]>
        {
            [QuestionCategory.General] = [9],                          // General Knowledge
            [QuestionCategory.Science] = [17, 19, 27],                 // Science & Nature, Mathematics, Animals
            [QuestionCategory.History] = [23, 24, 20],                 // History, Politics, Mythology
            [QuestionCategory.Geography] = [22],                       // Geography
            [QuestionCategory.Sports] = [21],                          // Sports
            [QuestionCategory.Entertainment] = [11, 12, 14, 15, 16, 26, 31, 32], // Film, Music, TV, Video/Board Games, Celebrities, Anime, Cartoons
            [QuestionCategory.Technology] = [18, 30, 28],              // Computers, Gadgets, Vehicles
            [QuestionCategory.ArtCulture] = [25, 10, 13, 29],          // Art, Books, Musicals & Theatre, Comics
        };

    private readonly IHttpClientFactory _httpFactory;
    private readonly IOptionsMonitor<FunQuizOptions> _options;
    private readonly ILogger<OpenTriviaDbClient> _logger;

    public OpenTriviaDbClient(
        IHttpClientFactory httpFactory,
        IOptionsMonitor<FunQuizOptions> options,
        ILogger<OpenTriviaDbClient> logger)
    {
        _httpFactory = httpFactory;
        _options = options;
        _logger = logger;
    }

    /// <summary>True when top-ups from opentdb.com are switched on.</summary>
    public bool Enabled => _options.CurrentValue.OpenTriviaDb.Enabled;

    /// <summary>Up to <paramref name="amount"/> validated questions, or an empty list on any failure.</summary>
    public async Task<IReadOnlyList<QuizQuestion>> FetchAsync(
        QuestionCategory category, int amount, CancellationToken cancellationToken)
    {
        var settings = _options.CurrentValue.OpenTriviaDb;
        if (!settings.Enabled) return [];

        amount = Math.Clamp(amount, 1, MaxPerCall);
        var ids = CategoryIds.TryGetValue(category, out var mapped) ? mapped : CategoryIds[QuestionCategory.General];
        var id = ids[Random.Shared.Next(ids.Length)];
        var url = $"{settings.BaseUrl}?amount={amount}&category={id}&type=multiple";

        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(settings.TimeoutSeconds, 1, 30)));

            var http = _httpFactory.CreateClient(HttpClientName);
            using var response = await http.GetAsync(url, timeout.Token);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogInformation("Open Trivia DB answered {Status} for category {Category}.", (int)response.StatusCode, category);
                return [];
            }

            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: timeout.Token);
            var parsed = Parse(doc.RootElement, category, out var responseCode);
            if (responseCode != 0)
                _logger.LogInformation("Open Trivia DB returned response_code {Code} for category {Category}.", responseCode, category);
            return parsed;
        }
        catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
        {
            // Timeout, DNS, TLS, malformed JSON: all mean "use the fallback", none is worth an alarm.
            _logger.LogInformation(ex, "Open Trivia DB unreachable for category {Category}; using the bundled set.", category);
            return [];
        }
    }

    /// <summary>Parses an OpenTDB reply. Items that fail <see cref="QuizQuality"/> are dropped.</summary>
    internal static List<QuizQuestion> Parse(JsonElement root, QuestionCategory category, out int responseCode)
    {
        responseCode = root.TryGetProperty("response_code", out var code) && code.TryGetInt32(out var c) ? c : -1;
        var results = new List<QuizQuestion>();
        if (responseCode != 0
            || !root.TryGetProperty("results", out var items)
            || items.ValueKind != JsonValueKind.Array)
        {
            return results;
        }

        foreach (var item in items.EnumerateArray())
        {
            if (TryRead(item, category) is { } question) results.Add(question);
        }
        return results;
    }

    private static QuizQuestion? TryRead(JsonElement item, QuestionCategory category)
    {
        if (item.ValueKind != JsonValueKind.Object) return null;
        var text = Decode(item, "question");
        var correct = Decode(item, "correct_answer");
        if (text is null || correct is null) return null;
        if (!item.TryGetProperty("incorrect_answers", out var wrongEl) || wrongEl.ValueKind != JsonValueKind.Array) return null;

        var options = new List<string>(4);
        foreach (var w in wrongEl.EnumerateArray())
        {
            if (w.ValueKind != JsonValueKind.String) return null;
            options.Add(WebUtility.HtmlDecode(w.GetString() ?? string.Empty).Trim());
        }
        if (options.Count != 3) return null;

        var answerIndex = Random.Shared.Next(4);
        options.Insert(answerIndex, correct);
        if (QuizQuality.Reject(text, options, answerIndex) is not null) return null;

        var difficulty = Decode(item, "difficulty") switch
        {
            "easy" => DifficultyLevel.Easy,
            "hard" => DifficultyLevel.Hard,
            _ => DifficultyLevel.Medium,
        };

        return new QuizQuestion
        {
            Text = text,
            Options = options,
            CorrectOptionIndex = answerIndex,
            Category = category,
            Difficulty = difficulty,
        };
    }

    private static string? Decode(JsonElement item, string property) =>
        item.TryGetProperty(property, out var el) && el.ValueKind == JsonValueKind.String
            && WebUtility.HtmlDecode(el.GetString() ?? string.Empty).Trim() is { Length: > 0 } value
            ? value
            : null;
}
