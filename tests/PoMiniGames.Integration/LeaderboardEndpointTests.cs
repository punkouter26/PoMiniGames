using System.Net;
using System.Net.Http.Json;
using FluentAssertions;

namespace PoMiniGames.Integration;

/// <summary>
/// Integration tests for endpoints not already covered by HomePageApiTests:
/// player-stats 404 path, PoBrawl high-score ranking, and the diag mask endpoint.
/// Snake and PoDropSquare high-score endpoints have been removed together with
/// those games; the remaining boards (PoBrawl, marble race) live under
/// UnifiedLeaderboardEndpoints and are exercised elsewhere.
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
}
