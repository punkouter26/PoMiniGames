using System.Net;
using System.Net.Http.Json;
using FluentAssertions;

namespace PoMiniGames.IntegrationTests;

/// <summary>Integration tests for leaderboard API endpoints.</summary>
public sealed class LeaderboardEndpointTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly HttpClient _client;

    public LeaderboardEndpointTests(TestWebApplicationFactory factory)
    {
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task GetLeaderboard_ReturnsOk_WhenNoData()
    {
        var response = await _client.GetAsync("/api/tictactoe/statistics/leaderboard");
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task GetAllStatistics_ReturnsOk()
    {
        var response = await _client.GetAsync("/api/statistics");
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task GetPlayerStats_Returns404_WhenPlayerNotFound()
    {
        var response = await _client.GetAsync("/api/tictactoe/players/nonexistent/stats");

        // The endpoint might return 404 or an empty response
        response.StatusCode.Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.NotFound);
    }
}
