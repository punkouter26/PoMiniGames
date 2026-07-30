using System.Net;
using System.Text.Json.Nodes;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;

namespace PoMiniGames.Integration;

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

    /// <summary>
    /// Every probe route the platform exposes: reachable, and carrying the JSON shape its
    /// caller reads. Consolidated from four single-route facts (ping / root health /
    /// liveness / mockables) into one parameterised method — they differed only in the route
    /// and which keys they asserted, and the Integration tier is at its 50-method ceiling
    /// (100/50/25/25 rule), so the slots were needed for the PoSurvive balance tests.
    /// </summary>
    [Theory]
    // Bare reachability — the client's apiService.isAvailable() only reads the status code.
    [InlineData("/api/health/ping", null, null, false)]
    // Root health carries both the overall status and the per-check breakdown.
    [InlineData("/health", "status", "checks", false)]
    // The canonical Kubernetes / App Service liveness probe; same body as /api/health.
    [InlineData("/api/health/liveness", "status", null, false)]
    // §5: a well-formed JSON ARRAY of mock identifiers. Shape, not contents — the inventory
    // depends on which game slices wired their IMockable into the test host.
    [InlineData("/api/mockables", null, null, true)]
    public async Task DiagnosticRoutes_ReturnOk_WithExpectedJsonShape(
        string route, string? statusKey, string? checksKey, bool expectJsonArray)
    {
        var response = await _client.GetAsync(route);
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var body = await response.Content.ReadAsStringAsync();
        body.Should().NotBeNullOrWhiteSpace();

        if (expectJsonArray)
        {
            var trimmed = body.TrimStart();
            trimmed.Should().StartWith("[");
            trimmed.Should().EndWith("]");
            return;
        }

        if (statusKey is null && checksKey is null)
            return;

        var json = JsonNode.Parse(body);
        json.Should().NotBeNull();

        if (statusKey is not null)
            json![statusKey]!.GetValue<string>().Should().NotBeNullOrWhiteSpace();

        if (checksKey is not null)
            json![checksKey].Should().NotBeNull();
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

}
