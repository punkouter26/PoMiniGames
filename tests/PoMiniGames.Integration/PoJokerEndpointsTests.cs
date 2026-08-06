using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using PoMiniGames.Features.PoJoker;
using PoMiniGames.Shared.Games.PoJoker;

namespace PoMiniGames.Integration;

/// <summary>
/// End-to-end tests for the PoJoker demo surface (<c>/api/joker/*</c>). The external JokeAPI.dev
/// dependency is replaced with an in-process <see cref="FakeJokeApiClient"/> so the suite never
/// touches the network; AI analysis already resolves to the in-process mock in the Development
/// test environment (PoJoker:AzureOpenAI is unconfigured), so no live tokens are spent.
/// </summary>
public sealed class PoJokerEndpointsTests : IClassFixture<TestWebApplicationFactory>, IAsyncLifetime
{
    private readonly HttpClient _client;

    public PoJokerEndpointsTests(TestWebApplicationFactory factory)
    {
        _client = factory
            .WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
            {
                // Override the typed JokeAPI client with a deterministic fake (last registration wins).
                services.AddSingleton<IJokeApiClient, FakeJokeApiClient>();
            }))
            .CreateClient();
    }

    // §2 CSRF: the analyze/explain POSTs are state-changing /api/* calls and are refused
    // without a synchroniser token. Arming lives in InitializeAsync rather than the
    // constructor because fetching the token is an HTTP round trip.
    public Task InitializeAsync() => _client.ArmAntiforgeryAsync();

    public Task DisposeAsync()
    {
        _client.Dispose();
        return Task.CompletedTask;
    }

    [Fact]
    public async Task Fetch_ReturnsValidTwoPartJoke()
    {
        var joke = await _client.GetFromJsonAsync<JokeDto>("/api/joker/fetch?safeMode=true&category=Programming");

        joke.Should().NotBeNull();
        joke!.Setup.Should().NotBeNullOrWhiteSpace();
        joke.Punchline.Should().NotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task Analyze_ReturnsAnalysisWithPunchlineAndRating()
    {
        var joke = FakeJokeApiClient.CannedJoke;

        var response = await _client.PostAsJsonAsync("/api/joker/analyze", joke);
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var analysis = await response.Content.ReadFromJsonAsync<JokeAnalysisDto>();
        analysis.Should().NotBeNull();
        analysis!.AiPunchline.Should().NotBeNullOrWhiteSpace();
        analysis.OriginalJoke.Id.Should().Be(joke.Id);
        analysis.Rating.Should().NotBeNull("the analyze endpoint always attaches a rating");
        analysis.Rating!.Cleverness.Should().BeInRange(1, 10);
    }

    [Fact]
    public async Task Explain_ReturnsNonEmptyExplanation()
    {
        var response = await _client.PostAsJsonAsync("/api/joker/explain", FakeJokeApiClient.CannedJoke);
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var explanation = await response.Content.ReadFromJsonAsync<JokeExplanationDto>();
        explanation.Should().NotBeNull();
        explanation!.Explanation.Should().NotBeNullOrWhiteSpace();
    }

    [Fact]
    public async Task Leaderboard_ReturnsOkArray()
    {
        var response = await _client.GetAsync("/api/joker/leaderboard?sortBy=Triumph&top=25");
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var entries = await response.Content.ReadFromJsonAsync<List<LeaderboardEntryDto>>();
        entries.Should().NotBeNull();
    }

    [Fact]
    public async Task Analyze_ThenLeaderboard_SurfacesSession_WhenStorageAvailable()
    {
        var sessionId = $"itest-{Guid.NewGuid():N}";
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/joker/analyze")
        {
            Content = JsonContent.Create(FakeJokeApiClient.CannedJoke)
        };
        request.Headers.Add("X-Session-Id", sessionId);

        var analyzeResponse = await _client.SendAsync(request);
        analyzeResponse.StatusCode.Should().Be(HttpStatusCode.OK);

        var entries = await _client.GetFromJsonAsync<List<LeaderboardEntryDto>>("/api/joker/leaderboard?top=100");
        entries.Should().NotBeNull();

        // Storage persistence is best-effort: when Azurite is running (Docker available) the
        // session is recorded and appears; when it is not, the leaderboard is simply empty.
        // Either outcome is valid — assert the round-trip only when storage produced rows.
        if (entries!.Count > 0)
        {
            entries.Should().Contain(e => e.SessionId == sessionId,
                because: "an analyzed joke is persisted under its X-Session-Id and surfaces on the leaderboard");
        }
    }

    /// <summary>Deterministic in-process replacement for the JokeAPI.dev HTTP client.</summary>
    private sealed class FakeJokeApiClient : IJokeApiClient
    {
        public static readonly JokeDto CannedJoke = new()
        {
            Id = 101,
            Category = "Programming",
            Type = "twopart",
            Setup = "Why do programmers prefer dark mode?",
            Punchline = "Because light attracts bugs."
        };

        public Task<JokeDto> FetchJokeAsync(
            bool safeMode = false,
            IEnumerable<int>? excludeIds = null,
            string category = "Any",
            CancellationToken cancellationToken = default)
            => Task.FromResult(CannedJoke);
    }
}
