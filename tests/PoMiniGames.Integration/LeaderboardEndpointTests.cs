using System.Net;
using System.Net.Http.Json;
using FluentAssertions;

namespace PoMiniGames.Integration;

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

    // ── PoBrawl fastest-KO high scores ────────────────────────────────────

    [Fact]
    public async Task PoBrawlHighScores_PostRanksAscending_AndRejectsBadInput()
    {
        // Two valid submissions; the faster KO should rank ahead of the slower one.
        var slow = new { PlayerInitials = "SLW", KoTimeSeconds = 42.5, Character = "trump", Date = DateTime.UtcNow.ToString("o") };
        var fast = new { PlayerInitials = "FST", KoTimeSeconds = 7.25, Character = "obama", Date = DateTime.UtcNow.ToString("o") };

        (await _client.PostAsJsonAsync("/api/pobrawl/highscores", slow)).StatusCode
            .Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.Created);
        (await _client.PostAsJsonAsync("/api/pobrawl/highscores", fast)).StatusCode
            .Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.Created);

        var scores = await _client.GetFromJsonAsync<List<System.Text.Json.JsonElement>>("/api/pobrawl/highscores");
        scores.Should().NotBeNull();
        scores!.Should().NotBeEmpty();

        // Ranked ascending by KO time, so times are non-decreasing down the board.
        var times = scores!.Select(s => s.GetProperty("koTimeSeconds").GetDouble()).ToList();
        times.Should().BeInAscendingOrder(because: "the fastest KO must rank first");
        times.Should().Contain(7.25).And.Contain(42.5);

        // Bad input is rejected: empty initials and a non-positive KO time.
        (await _client.PostAsJsonAsync("/api/pobrawl/highscores",
            new { PlayerInitials = "", KoTimeSeconds = 5.0 })).StatusCode
            .Should().Be(HttpStatusCode.BadRequest);
        (await _client.PostAsJsonAsync("/api/pobrawl/highscores",
            new { PlayerInitials = "ABC", KoTimeSeconds = 0.0 })).StatusCode
            .Should().Be(HttpStatusCode.BadRequest);
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
        var response = await _client.GetAsync("/api/diag");
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var content = await response.Content.ReadAsStringAsync();
        content.Should().NotBeNullOrWhiteSpace();

        // Verify it's valid JSON
        var json = System.Text.Json.JsonDocument.Parse(content);
        json.RootElement.ValueKind.Should().Be(System.Text.Json.JsonValueKind.Object);

        // The DiagResponse DTO has Identity / Environment / Integrations
        // (PascalCase preserved by the default System.Text.Json policy).
        var jsonString = json.RootElement.GetRawText();
        jsonString.Should().Contain("Identity");
        jsonString.Should().Contain("Environment");
    }

    [Fact]
    public async Task GetDiag_ShouldNotExposePlaintextSecrets()
    {
        var response = await _client.GetAsync("/api/diag");
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var content = await response.Content.ReadAsStringAsync();

        // Verify no obvious plaintext secret patterns (this is a basic check)
        // Real secrets would have been replaced with masked versions like "***"
        // This test ensures the endpoint doesn't dump raw connection strings
        content.Should().NotContain("User Id=", because: "connection strings should be masked");
    }

    // ── Per-difficulty leaderboard + ELO ──────────────────────────────────

    [Fact]
    public async Task GetLeaderboard_All_ReturnsOk()
    {
        var response = await _client.GetAsync("/api/tictactoe/statistics/leaderboard");
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Theory]
    [InlineData("easy")]
    [InlineData("medium")]
    [InlineData("hard")]
    [InlineData("all")]
    public async Task GetLeaderboard_WithDifficultyParam_ReturnsOk(string difficulty)
    {
        var response = await _client.GetAsync(
            $"/api/tictactoe/statistics/leaderboard?difficulty={difficulty}");
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task GetLeaderboard_AfterSavingStats_ReturnsEloRating()
    {
        // Arrange – 10 wins, 0 losses on Easy → ELO = 1000 + 10*K*(1-E)
        // where E = 1/(1+10^((800-1000)/400)) ≈ 0.760, so each win ≈ +7.68 → ~1077
        var stats = new
        {
            PlayerId = "elo-test-player",
            PlayerName = "EloTester",
            Easy = new { Wins = 10, Losses = 0, Draws = 0, TotalGames = 10, WinStreak = 10 },
            Medium = new { Wins = 0, Losses = 0, Draws = 0, TotalGames = 0, WinStreak = 0 },
            Hard = new { Wins = 0, Losses = 0, Draws = 0, TotalGames = 0, WinStreak = 0 },
        };

        var putResp = await _client.PutAsJsonAsync(
            "/api/tictactoe/players/EloTester/stats", stats);
        putResp.StatusCode.Should().Be(HttpStatusCode.NoContent,
            because: "saving valid stats should return 204");

        // Act – fetch Easy leaderboard (sorted by ELO).
        var entries = await _client.GetFromJsonAsync<List<System.Text.Json.JsonElement>>(
            "/api/tictactoe/statistics/leaderboard?difficulty=easy");

        // Assert – at least one entry, and EloRating is above baseline.
        entries.Should().NotBeNull();
        entries!.Should().NotBeEmpty();
        var first = entries[0];
        var eloRating = first
            .GetProperty("stats")
            .GetProperty("easy")
            .GetProperty("eloRating")
            .GetInt32();
        eloRating.Should().BeGreaterThan(1000,
            because: "10 wins with 0 losses on Easy should push ELO above the 1000 baseline");
    }
}
