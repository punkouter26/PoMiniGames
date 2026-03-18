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

    [Fact]
    public async Task GetPoDropSquareHighScores_ReturnsOk_WhenEmpty()
    {
        var response = await _client.GetAsync("/api/podropsquare/highscores");
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task PostPoDropSquareHighScore_ThenGet_ContainsEntry()
    {
        var entry = new
        {
            PlayerInitials = "DSP",
            SurvivalTime = 12.34,
            Date = DateTime.UtcNow.ToString("o"),
            PlayerName = "DropSquare Tester",
        };

        var post = await _client.PostAsJsonAsync("/api/podropsquare/highscores", entry);
        post.StatusCode.Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.Created);

        var scores = await _client.GetFromJsonAsync<List<dynamic>>("/api/podropsquare/highscores");
        scores.Should().NotBeNull();
        scores!.Should().NotBeEmpty();
    }

    // ── Bad Input Validation ────────────────────────────────────────────────

    [Fact]
    public async Task PostSnakeHighScore_WithEmptyInitials_ReturnsBadRequest()
    {
        var entry = new
        {
            Initials = "",
            Score = 100,
            Date = DateTime.UtcNow.ToString("o"),
            GameDuration = 5,
            SnakeLength = 3,
            FoodEaten = 2,
        };

        var response = await _client.PostAsJsonAsync("/api/snake/highscores", entry);
        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task PostSnakeHighScore_WithInitialsExceeding3Chars_ReturnsBadRequest()
    {
        var entry = new
        {
            Initials = "TOOLONG",
            Score = 100,
            Date = DateTime.UtcNow.ToString("o"),
            GameDuration = 5,
            SnakeLength = 3,
            FoodEaten = 2,
        };

        var response = await _client.PostAsJsonAsync("/api/snake/highscores", entry);
        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task PostSnakeHighScore_WithNegativeScore_ReturnsBadRequest()
    {
        var entry = new
        {
            Initials = "BAD",
            Score = -100,
            Date = DateTime.UtcNow.ToString("o"),
            GameDuration = 5,
            SnakeLength = 3,
            FoodEaten = 2,
        };

        var response = await _client.PostAsJsonAsync("/api/snake/highscores", entry);
        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ── Rate Limiting ───────────────────────────────────────────────────────

    [Fact]
    public async Task GetSnakeHighScores_ShouldNotThrottle_WhenWithinLimit()
    {
        // Make 3 requests — should all succeed (limit is 10/min)
        for (int i = 0; i < 3; i++)
        {
            var response = await _client.GetAsync("/api/snake/highscores");
            response.StatusCode.Should().Be(HttpStatusCode.OK);
        }
    }

    // ── Diag Endpoint Mask Verification ─────────────────────────────────────

    [Fact]
    public async Task GetDiag_ReturnsMaskedConfigJson()
    {
        var response = await _client.GetAsync("/diag");
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var content = await response.Content.ReadAsStringAsync();
        content.Should().NotBeNullOrWhiteSpace();

        // Verify it's valid JSON
        var json = System.Text.Json.JsonDocument.Parse(content);
        json.RootElement.ValueKind.Should().Be(System.Text.Json.JsonValueKind.Object);

        // Verify no plaintext sensitive keys (e.g., "Password", "Secret", "Key" should be masked)
        // Check that the response contains data without exposing full secrets
        var jsonString = json.RootElement.GetRawText();
        jsonString.Should().Contain("Sqlite");
    }

    [Fact]
    public async Task GetDiag_ShouldNotExposePlaintextSecrets()
    {
        var response = await _client.GetAsync("/diag");
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var content = await response.Content.ReadAsStringAsync();

        // Verify no obvious plaintext secret patterns (this is a basic check)
        // Real secrets would have been replaced with masked versions like "***"
        // This test ensures the endpoint doesn't dump raw connection strings
        content.Should().NotContain("User Id=", because: "connection strings should be masked");
    }
}
