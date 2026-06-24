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
    public async Task RootHealthEndpoint_ReturnsStructuredJson()
    {
        var response = await _client.GetAsync("/health");
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var body = await response.Content.ReadAsStringAsync();
        var json = JsonNode.Parse(body);

        json.Should().NotBeNull();
        json!["status"]!.GetValue<string>().Should().NotBeNullOrWhiteSpace();
        json["checks"].Should().NotBeNull();
    }

    [Fact]
    public async Task DiagEndpoint_ReturnsOk()
    {
        // The programmatic snapshot lives at /api/diag; bare /diag is the Blazor page route
        // (it would fall through to the SPA index.html fallback and return HTML, not JSON).
        var response = await _client.GetAsync("/api/diag");
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var body = await response.Content.ReadAsStringAsync();
        var json = JsonNode.Parse(body);

        json.Should().NotBeNull();
        json!["storage"]!["provider"]!.GetValue<string>().Should().Be("AzureTableStorage");
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

            // The Production fail-fast guard reads the storage AccountName EAGERLY at
            // host-builder time (Program.cs, before Build), so it must come through web-host
            // configuration via UseSetting — an in-memory app-configuration source is applied
            // post-Build and lands too late. The BlobContainerClient is constructed lazily and
            // never contacted by a diagnostics-disabled 404, so no real Azure call is made.
            builder.UseSetting("PoMiniGames:Storage:TableService:AccountName", "devstoreaccount1");

            builder.ConfigureAppConfiguration((_, cfg) =>
            {
                cfg.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["FeatureFlags:EnableDiagnostics"] = "false",
                });
            });
        });

        using var client = productionFactory.CreateClient();
        var response = await client.GetAsync("/api/diag");

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }
}
