using System.Net;
using FluentAssertions;

namespace PoMiniGames.IntegrationTests;

/// <summary>Integration tests for health and diagnostic API endpoints.</summary>
public sealed class HealthEndpointTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly HttpClient _client;

    public HealthEndpointTests(TestWebApplicationFactory factory)
    {
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task HealthPing_ReturnsOk()
    {
        var response = await _client.GetAsync("/api/health/ping");
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task DiagEndpoint_ReturnsOk()
    {
        var response = await _client.GetAsync("/diag");
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var body = await response.Content.ReadAsStringAsync();
        body.Should().Contain("Sqlite");
    }
}
