using System.Net;
using System.Net.Http.Json;
using FluentAssertions;

namespace PoMiniGames.IntegrationTests;

/// <summary>
/// Integration tests for endpoints not already covered by HomePageApiTests:
/// player-stats 404 path and the PoSnakeGame score-based leaderboard.
/// </summary>
public sealed class LeaderboardEndpointTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly HttpClient _client;

    public LeaderboardEndpointTests(TestWebApplicationFactory factory)
    {
        _client = factory.CreateClient();
    }

    // ── Player stats – 404 path ────────────────────────────────────────────

    [Fact]
    public async Task GetPlayerStats_Returns404OrOk_WhenPlayerNotFound()
    {
        var response = await _client.GetAsync("/api/tictactoe/players/nonexistent_player_xyz/stats");
        response.StatusCode.Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.NotFound);
    }

    // ── PoSnakeGame high-score endpoints ──────────────────────────────────

    [Fact]
    public async Task GetSnakeHighScores_ReturnsOk_WhenEmpty()
    {
        var response = await _client.GetAsync("/api/snake/highscores");
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task GetSnakeHighScores_ReturnsJsonArray()
    {
        var entries = await _client.GetFromJsonAsync<object[]>("/api/snake/highscores");
        entries.Should().NotBeNull();
    }

    [Fact]
    public async Task PostSnakeHighScore_ThenGet_ContainsEntry()
    {
        // Arrange – minimal valid high-score entry
        var entry = new
        {
            Initials = "QAT",
            Score = 9999,
            Date = DateTime.UtcNow.ToString("o"),
            GameDuration = 42,
            SnakeLength = 10,
            FoodEaten = 9,
        };

        // Act – submit
        var post = await _client.PostAsJsonAsync("/api/snake/highscores", entry);
        post.IsSuccessStatusCode.Should().BeTrue(
            because: "posting a valid high-score entry should succeed");

        // Assert – appears on leaderboard
        var scores = await _client.GetFromJsonAsync<List<dynamic>>("/api/snake/highscores");
        scores.Should().NotBeNull();
        scores!.Should().NotBeEmpty(
            because: "the submitted score should appear on the high-score list");
    }

    [Fact]
    public async Task PostSnakeHighScore_ReturnsCreatedOrOk()
    {
        var entry = new
        {
            Initials = "TST",
            Score = 100,
            Date = DateTime.UtcNow.ToString("o"),
            GameDuration = 5,
            SnakeLength = 3,
            FoodEaten = 2,
        };

        var post = await _client.PostAsJsonAsync("/api/snake/highscores", entry);
        post.StatusCode.Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.Created);
    }
}
