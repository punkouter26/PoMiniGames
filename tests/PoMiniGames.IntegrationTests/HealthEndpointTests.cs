using System.Net;
using System.Text.Json.Nodes;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;

namespace PoMiniGames.IntegrationTests;

/// <summary>Integration tests for health and diagnostic API endpoints.</summary>
public sealed class HealthEndpointTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly TestWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public HealthEndpointTests(TestWebApplicationFactory factory)
    {
        _factory = factory;
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
        var json = JsonNode.Parse(body);

        json.Should().NotBeNull();
        json!["storage"]!["databaseFileName"]!.GetValue<string>().Should().Be("pominigames.db");
        json["logging"]!["devLogFile"]!.GetValue<string>().Should().Be("logs/pominigames-.log");
        body.Should().NotContain("APPLICATIONINSIGHTS_CONNECTION_STRING");
        body.Should().NotContain("InstrumentationKey", because: "diag should not expose raw secret values");
    }

    [Fact]
    public async Task DiagEndpoint_ReturnsNotFound_WhenDiagnosticsDisabled()
    {
        using var productionFactory = _factory.WithWebHostBuilder(builder =>
        {
            builder.UseEnvironment("Production");
            builder.ConfigureAppConfiguration((_, cfg) =>
            {
                cfg.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["FeatureFlags:EnableDiagnostics"] = "false",
                });
            });
        });

        using var client = productionFactory.CreateClient();
        var response = await client.GetAsync("/diag");

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }
}
