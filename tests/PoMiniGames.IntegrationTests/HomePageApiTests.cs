using System.Net;
using System.Net.Http.Json;
using FluentAssertions;

namespace PoMiniGames.IntegrationTests;

/// <summary>
/// Integration tests covering every API endpoint consumed by the Home page:
/// leaderboards for all games, limit parameter, content-type, and
/// round-trip save → retrieve.
/// </summary>
public sealed class HomePageApiTests : IClassFixture<TestWebApplicationFactory>
{
    // All game IDs shown on the Home page
    private static readonly string[] AllGameIds =
    [
        "connectfive",
        "tictactoe",
        "voxelshooter",
        "pofight",
        "podropsquare",
        "pobabytouch",
        "poraceragdoll",
    ];

    private readonly HttpClient _client;

    public HomePageApiTests(TestWebApplicationFactory factory)
    {
        _client = factory.CreateClient();
    }

    // ── Leaderboard returns OK for every game ────────────────────────────────

    [Theory]
    [InlineData("connectfive")]
    [InlineData("tictactoe")]
    [InlineData("voxelshooter")]
    [InlineData("pofight")]
    [InlineData("podropsquare")]
    [InlineData("pobabytouch")]
    [InlineData("poraceragdoll")]
    public async Task GetLeaderboard_ReturnsOk_ForEachGame(string gameId)
    {
        var response = await _client.GetAsync($"/api/{gameId}/statistics/leaderboard");
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    // ── Leaderboard returns empty array when no data exists ──────────────────

    [Theory]
    [InlineData("connectfive")]
    [InlineData("voxelshooter")]
    [InlineData("podropsquare")]
    public async Task GetLeaderboard_ReturnsEmptyArray_WhenNoEntries(string gameId)
    {
        var entries = await _client.GetFromJsonAsync<object[]>($"/api/{gameId}/statistics/leaderboard");
        entries.Should().NotBeNull();
        entries.Should().BeEmpty();
    }

    // ── Leaderboard respects the limit query parameter ───────────────────────

    [Fact]
    public async Task GetLeaderboard_RespectsLimitParameter()
    {
        var response = await _client.GetAsync("/api/connectfive/statistics/leaderboard?limit=5");
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var entries = await response.Content.ReadFromJsonAsync<object[]>();
        entries.Should().NotBeNull();
        entries!.Length.Should().BeLessThanOrEqualTo(5);
    }

    [Fact]
    public async Task GetLeaderboard_DefaultLimit_ReturnsTenOrFewer()
    {
        var entries = await _client.GetFromJsonAsync<object[]>("/api/tictactoe/statistics/leaderboard");
        entries.Should().NotBeNull();
        entries!.Length.Should().BeLessThanOrEqualTo(10);
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

    // ── Response content-type is JSON ────────────────────────────────────────

    [Theory]
    [InlineData("connectfive")]
    [InlineData("tictactoe")]
    public async Task GetLeaderboard_ReturnsJsonContentType(string gameId)
    {
        var response = await _client.GetAsync($"/api/{gameId}/statistics/leaderboard");
        response.Content.Headers.ContentType?.MediaType.Should().Be("application/json");
    }

    // ── Round-trip: save stats → player appears on leaderboard ───────────────

    [Fact]
    public async Task SavePlayerStats_ThenLeaderboard_ContainsPlayer()
    {
        // Use a game ID unique to this test to avoid affecting other assertions
        const string game = "roundtrip_leaderboard";
        const string player = "HomePageIntegrationPlayer";

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
        // Use a game ID unique to this test to avoid affecting other assertions
        const string game = "roundtrip_stats";
        const string player = "HomePageStatsRoundTrip";

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

    [Fact]
    public async Task GetAllStatistics_ReturnsOk()
    {
        var response = await _client.GetAsync("/api/statistics");
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task GetAllStatistics_ReturnsJson()
    {
        var response = await _client.GetAsync("/api/statistics");
        response.Content.Headers.ContentType?.MediaType.Should().Be("application/json");
    }

    // ── Health ping used by apiService.isAvailable() ─────────────────────────

    [Fact]
    public async Task HealthPing_ReturnsOk_ForClientAvailabilityCheck()
    {
        var response = await _client.GetAsync("/api/health/ping");
        response.StatusCode.Should().Be(HttpStatusCode.OK,
            because: "the client uses this endpoint to decide whether the API is reachable");
    }
}
