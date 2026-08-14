using System.Diagnostics;
using PoMiniGames.Shared.Games.PoJoker;

namespace PoMiniGames.Features.PoJoker;

/// <summary>
/// Mock AI analysis service for development without Azure OpenAI. Returns random
/// punchline predictions. Used as the non-Production fallback when the PoJoker
/// Azure OpenAI section is not configured (mirrors the PoCoupleQuiz mock pattern).
/// </summary>
public sealed class MockAnalysisService(ILogger<MockAnalysisService> logger) : IAnalysisService
{
    private static readonly string[] MockPunchlines =
    [
        "Because they can't handle the byte!",
        "It was too mainstream!",
        "They wanted to C# clearly!",
        "Because it had no body!",
        "It couldn't find its class!",
        "They lost their inheritance!",
        "It kept throwing exceptions!",
        "The algorithm was too complex!",
        "Because nobody expected it!",
        "That's what she said!",
        "Turns out it was all in the timing!",
        "It ran out of punchlines first!",
        "Because the setup was half the joke!",
        "Nobody told the punchline it was coming!",
        "It slipped on a banana peel of logic!",
        "Because the answer was obvious all along!",
        "Three, because ice cream has no bones!",
        "It forgot to carry the one!",
        "Because a funnier one was already taken!",
        "The silence afterward was the real punchline!",
        "It phoned it in from the wrong area code!",
        "Because irony was on vacation!",
        "Nobody told the universe about the punchline either!",
    ];

    private readonly Random _random = new();
    private readonly ILogger<MockAnalysisService> _logger = logger;

    private async Task<JokeAnalysisDto> PredictPunchlineAsync(JokeDto joke, CancellationToken cancellationToken = default)
    {
        var stopwatch = Stopwatch.StartNew();

        // Simulate AI processing time
        await Task.Delay(_random.Next(200, 800), cancellationToken);

        var mockPunchline = MockPunchlines[_random.Next(MockPunchlines.Length)];

        stopwatch.Stop();

        // Random chance of triumph (20% to make it interesting)
        var isTriumph = _random.NextDouble() < 0.2;
        var similarityScore = isTriumph ? _random.NextDouble() * 0.2 + 0.8 : _random.NextDouble() * 0.5;

        _logger.LogInformation(
            "[MOCK] AI predicted punchline for joke {JokeId}: IsTriumph={IsTriumph}",
            joke.Id, isTriumph);

        return new JokeAnalysisDto
        {
            OriginalJoke = joke,
            AiPunchline = mockPunchline,
            Confidence = _random.NextDouble() * 0.3 + 0.6,
            IsTriumph = isTriumph,
            SimilarityScore = similarityScore,
            LatencyMs = stopwatch.ElapsedMilliseconds
        };
    }

    private async Task<JokeRatingDto> RateJokeAsync(JokeDto joke, CancellationToken cancellationToken = default)
    {
        await Task.Delay(_random.Next(100, 300), cancellationToken);

        return new JokeRatingDto
        {
            Cleverness = _random.Next(1, 11),
            Rudeness = _random.Next(1, 5),
            Complexity = _random.Next(1, 11),
            Difficulty = _random.Next(1, 11),
            Commentary = "A jest of reasonable mirth!",
            Emotion = MockEmotion(joke),
        };
    }

    /// <summary>
    /// A stand-in for the rating model's topic read, so a developer without a foundry still sees
    /// the audience change expression instead of a show of 10 identical neutral portraits.
    /// </summary>
    /// <remarks>
    /// Deliberately NOT random: the same joke must draw the same face every time, or a re-fetch of
    /// a joke already seen this session contradicts itself on stage. Keyword-then-hash, so even a
    /// joke matching nothing still lands somewhere stable and non-neutral.
    /// </remarks>
    private static string MockEmotion(JokeDto joke)
    {
        var text = joke.FullText.ToLowerInvariant();

        foreach (var (needle, emotion) in MockEmotionKeywords)
        {
            if (text.Contains(needle, StringComparison.Ordinal))
                return emotion;
        }

        // Stable spread over the whole portrait set. string.GetHashCode is randomized per process,
        // so it would give the same joke a different face on every restart — sum the chars instead.
        var seed = 0;
        foreach (var c in text) seed = unchecked(seed + c);
        return JokerEmotions.All[Math.Abs(seed) % JokerEmotions.All.Length];
    }

    private static readonly (string Needle, string Emotion)[] MockEmotionKeywords =
    [
        ("dead", "dying"), ("death", "dying"), ("grave", "dying"), ("funeral", "dying"),
        ("drunk", "drunk"), ("beer", "drunk"), ("bar", "drunk"), ("wine", "drunk"),
        ("wife", "blushing"), ("sex", "blushing"), ("date", "blushing"),
        ("toilet", "disgust"), ("fart", "disgust"), ("smell", "disgust"),
        ("scared", "fear"), ("ghost", "fear"), ("spider", "fear"),
        ("doctor", "wounded"), ("hospital", "wounded"), ("hurt", "wounded"),
        ("sleep", "unconscious"), ("bed", "unconscious"),
        ("police", "stealthy"), ("steal", "stealthy"), ("thief", "stealthy"),
        ("program", "concentrating"), ("code", "concentrating"), ("computer", "concentrating"),
        ("why did", "thinking"), ("what do you call", "thinking"), ("knock knock", "eye-roll"),
    ];

    public async Task<(JokeAnalysisDto Analysis, JokeRatingDto Rating)> AnalyzeJokeAsync(JokeDto joke, CancellationToken cancellationToken = default)
    {
        var analysis = await PredictPunchlineAsync(joke, cancellationToken);
        var rating = await RateJokeAsync(joke, cancellationToken);
        return (analysis, rating);
    }

    public Task<string> ExplainJokeAsync(JokeDto joke, CancellationToken cancellationToken = default)
        => Task.FromResult(
            "The setup leads the listener to expect a conventional outcome, while the punchline reveals an " +
            "absurd or literal interpretation that subverts that expectation for comic effect. " +
            "[Mock explanation — connect Azure OpenAI to see real analysis.]");
}
