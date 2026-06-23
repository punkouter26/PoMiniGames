namespace PoMiniGames.E2EAPI;

/// <summary>
/// §5 Deployment smoke tests. C# port of <c>deployment-smoke.spec.js</c>
/// (deleted during the JS → C# e2e migration). Asserts the routes that the
/// Azure App Service availability test pings. Failure of any of these means
/// a regression in the BFF static-file hosting or the BFF /api prefix.
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public class DeploymentSmokeTests
{
    private readonly PoMiniGamesE2EFixture _factory;

    public DeploymentSmokeTests(PoMiniGamesE2EFixture factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task HealthEndpoint_Is200()
    {
        using var client = _factory.CreateClient();
        var response = await client.GetAsync("/health");
        response.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task ApiPrefix_RoutesAreReachable()
    {
        using var client = _factory.CreateClient();

        // The /api/auth/config route is the cheapest public probe; the other
        // BFF routes (hubs, leaderboards) require setup that this fixture
        // intentionally doesn't provide.
        var config = await client.GetAsync("/api/auth/config");
        config.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task OpenApiDocument_IsPublished()
    {
        using var client = _factory.CreateClient();
        var response = await client.GetAsync("/openapi/v1.json");

        // §2.1: Microsoft.AspNetCore.OpenApi must publish the schema doc.
        response.EnsureSuccessStatusCode();
    }
}
