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
        // The DiagResponse DTO projects Identity / Environment / Integrations
        // (System.Text.Json default policy preserves the C# PascalCase names).
        json!["Identity"]!.Should().NotBeNull();
        json["Identity"]!["Ports"]!["Http"]!.GetValue<int>().Should().Be(5000);
        json["Environment"]!["Name"]!.GetValue<string>().Should().Be("Development");
        json["Environment"]!["ApplicationName"]!.GetValue<string>().Should().Be("PoMiniGames");
        body.Should().NotContain("APPLICATIONINSIGHTS_CONNECTION_STRING");
        body.Should().NotContain("InstrumentationKey", because: "diag should not expose raw secret values");
    }

    [Fact]
    public async Task DiagEndpoint_ReturnsNotFound_WhenDiagnosticsDisabled()
    {
        // The Production-env fail-fast contract is exercised by Program.cs at host start:
        //   - FakeAuth scheme registration → throws
        //   - Auth:AutoGuestLogin=true       → throws
        //   - Missing storage AccountName    → throws
        // Those guards are unit-tested separately in StartupSecretValidatorTests. Here
        // we only assert the HTTP contract for the diagnostics-disabled case, so we
        // stay in Development (cheaper, hermetic) and just toggle the feature flag.
        using var diagDisabledFactory = _factory.WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, cfg) =>
            {
                cfg.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["FeatureFlags:EnableDiagnostics"] = "false",
                });
            });
        });

        using var client = diagDisabledFactory.CreateClient();
        var response = await client.GetAsync("/api/diag");

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Mockables_ReturnsOkAndValidJsonShape_WhenInDevelopment()
    {
        // §5: the diagnostic endpoint exists and returns a well-formed JSON array
        // of mock identifiers. The exact contents depend on which game slices have
        // their IMockable implementations wired into the test host — we assert the
        // shape (array) rather than the count so the suite is not coupled to the
        // exact mock inventory.
        var response = await _client.GetAsync("/api/mockables");
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var body = await response.Content.ReadAsStringAsync();
        body.Should().NotBeNullOrWhiteSpace();
        var trimmed = body.TrimStart();
        trimmed.Should().StartWith("[");
        trimmed.Should().EndWith("]");
    }
}
