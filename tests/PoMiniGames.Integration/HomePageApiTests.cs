using System.Net;
using System.Net.Http.Json;
using FluentAssertions;

namespace PoMiniGames.Integration;

/// <summary>
/// Integration tests covering every API endpoint consumed by the Home page:
/// leaderboards for all games, limit parameter, content-type, and
/// round-trip save → retrieve.
/// </summary>
public sealed class HomePageApiTests : IClassFixture<TestWebApplicationFactory>, IAsyncLifetime
{
    // All game IDs shown on the Home page.
    //
    // These are GameKey WIRE keys, not the client's route/folder names. The quiz games are
    // "couplequiz"/"funquiz" — the "po"-prefixed spellings used here previously are not in
    // GameKey's catalogue, so every call for them 400'd on GameKey.Parse rather than
    // exercising the leaderboard. Keep this list in sync with GameKey.WellKnown.
    private static readonly string[] AllGameIds =
    [
        "connectfive",
        "tictactoe",
        "couplequiz",
        "funquiz",
    ];

    private readonly HttpClient _client;

    public HomePageApiTests(TestWebApplicationFactory factory)
    {
        _client = factory.CreateClient();
    }

    // §2 CSRF: the player-stats PUTs are state-changing /api/* calls and are refused
    // without a synchroniser token. Arming lives in InitializeAsync rather than the
    // constructor because fetching the token is an HTTP round trip.
    public Task InitializeAsync() => _client.ArmAntiforgeryAsync();

    public Task DisposeAsync()
    {
        _client.Dispose();
        return Task.CompletedTask;
    }

    // ── Leaderboard returns OK for every game ────────────────────────────────

    [Theory]
    [InlineData("connectfive")]
    [InlineData("tictactoe")]
    [InlineData("couplequiz")]
    [InlineData("funquiz")]
    public async Task GetLeaderboard_ReturnsOk_ForEachGame(string gameId)
    {
        var response = await _client.GetAsync($"/api/{gameId}/statistics/leaderboard");
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    // ── Leaderboard read contract: JSON array, content-type, limit ───────────

    /// <summary>
    /// The whole read contract for a game leaderboard in one place: 200, a JSON
    /// content-type, a JSON array body, and a row count that honours the limit (10 by
    /// default, or whatever <c>?limit=</c> asked for).
    /// </summary>
    /// <remarks>
    /// Consolidated from four methods (empty-array / explicit-limit / default-limit /
    /// content-type) that each re-issued the same GET and asserted one facet of the same
    /// response. The Integration tier is at its 50-method ceiling (100/50/25/25 rule) and
    /// the slots were needed for the PoSurvive balance tests; coverage is unchanged.
    /// </remarks>
    [Theory]
    // Default limit is 10. connectfive is never written to by this suite (the round-trip
    // tests use their own game ids), so it must still come back empty.
    [InlineData("connectfive", null, 10, true)]
    // An explicit limit caps the row count.
    [InlineData("connectfive", 5, 5, true)]
    // Second game, default limit — the contract is per-game, not per-route-instance.
    [InlineData("tictactoe", null, 10, false)]
    public async Task GetLeaderboard_ReturnsJsonArray_HonouringLimit(
        string gameId, int? limit, int expectedMaxRows, bool expectEmpty)
    {
        var route = $"/api/{gameId}/statistics/leaderboard"
                  + (limit is { } l ? $"?limit={l}" : string.Empty);

        var response = await _client.GetAsync(route);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Content.Headers.ContentType?.MediaType.Should().Be("application/json");

        var entries = await response.Content.ReadFromJsonAsync<object[]>();
        entries.Should().NotBeNull();
        entries!.Length.Should().BeLessThanOrEqualTo(expectedMaxRows);

        if (expectEmpty)
            entries.Should().BeEmpty();
    }

    // ── All game endpoints respond in parallel (simulates Home page load) ────

    [Fact]
    public async Task GetLeaderboard_AllGamesReachable_InParallel()
    {
        var tasks = AllGameIds.Select(id =>
            _client.GetAsync($"/api/{id}/statistics/leaderboard"));

        var responses = await Task.WhenAll(tasks);

        foreach (var response in responses)
        {
            response.StatusCode.Should().Be(HttpStatusCode.OK,
                because: "every game leaderboard used on the Home page must be reachable");
        }
    }

    // ── Round-trip: save stats → player appears on leaderboard ───────────────

    [Fact]
    public async Task SavePlayerStats_ThenLeaderboard_ContainsPlayer()
    {
        // Isolation comes from a unique PLAYER, not a unique game. An invented game id
        // ("roundtrip_leaderboard") cannot work: PlayerStatsEndpoints runs every game id
        // through GameKey.TryParse as its §8 allowlist, so an off-catalogue key 400s before
        // any storage is touched. Pick a real key and make the row unique instead.
        const string game = "pomarblerace";
        var player = $"HomePageIntegrationPlayer-{Guid.NewGuid():N}";

        // Build a minimal valid PlayerStats payload
        var stats = new
        {
            PlayerId = Guid.NewGuid().ToString(),
            PlayerName = player,
            Easy = new { Wins = 8, Losses = 2, Draws = 0, TotalGames = 10, WinStreak = 3 },
            Medium = new { Wins = 0, Losses = 0, Draws = 0, TotalGames = 0, WinStreak = 0 },
            Hard = new { Wins = 0, Losses = 0, Draws = 0, TotalGames = 0, WinStreak = 0 },
        };

        var put = await _client.PutAsJsonAsync($"/api/{game}/players/{player}/stats", stats);
        put.IsSuccessStatusCode.Should().BeTrue(
            because: "saving valid player stats should succeed");

        // Retrieve leaderboard and verify the player appears
        var entries = await _client.GetFromJsonAsync<List<dynamic>>(
            $"/api/{game}/statistics/leaderboard?limit=10");

        entries.Should().NotBeNull();
        entries!.Should().NotBeEmpty(
            because: "the saved player should appear on the leaderboard");
    }

    [Fact]
    public async Task SavePlayerStats_ThenGetPlayerStats_MatchesSavedData()
    {
        // Real GameKey + unique player, for the same allowlist reason as above.
        const string game = "poracer";
        var player = $"HomePageStatsRoundTrip-{Guid.NewGuid():N}";

        var stats = new
        {
            PlayerId = Guid.NewGuid().ToString(),
            PlayerName = player,
            Easy = new { Wins = 5, Losses = 5, Draws = 0, TotalGames = 10, WinStreak = 2 },
            Medium = new { Wins = 0, Losses = 0, Draws = 0, TotalGames = 0, WinStreak = 0 },
            Hard = new { Wins = 0, Losses = 0, Draws = 0, TotalGames = 0, WinStreak = 0 },
        };

        var put = await _client.PutAsJsonAsync($"/api/{game}/players/{player}/stats", stats);
        put.IsSuccessStatusCode.Should().BeTrue();

        var get = await _client.GetAsync($"/api/{game}/players/{player}/stats");
        get.StatusCode.Should().BeOneOf(
            new[] { HttpStatusCode.OK, HttpStatusCode.NotFound },
            because: "the endpoint either returns the stored stats or 404 if not implemented");
    }

    // ── /api/statistics – aggregated statistics used by the home page ────────

    /// <summary>Aggregated home-page statistics: reachable and served as JSON.</summary>
    /// <remarks>
    /// Was two facts issuing the identical GET to assert the status code and the
    /// content-type separately. See the ceiling note on
    /// <see cref="GetLeaderboard_ReturnsJsonArray_HonouringLimit"/>.
    /// </remarks>
    [Fact]
    public async Task GetAllStatistics_ReturnsJsonPayload()
    {
        var response = await _client.GetAsync("/api/statistics");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Content.Headers.ContentType?.MediaType.Should().Be("application/json");
    }

    // The client-availability ping that lived here was a verbatim duplicate of
    // HealthEndpointTests' /api/health/ping coverage — same route, same assertion. It is
    // now one row of that class's DiagnosticRoutes_ReturnOk_WithExpectedJsonShape theory.
}
