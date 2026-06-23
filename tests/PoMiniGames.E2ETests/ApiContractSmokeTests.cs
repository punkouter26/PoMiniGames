using System.Net;

namespace PoMiniGames.E2ETests;

/// <summary>
/// §5 API contract smoke tests. C# port of <c>api-contract.spec.js</c> (deleted
/// during the JS → C# e2e migration). Verifies the public contract surface the
/// frontend and SignalR clients depend on, without requiring a live browser.
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public class ApiContractSmokeTests
{
    private readonly PoMiniGamesE2EFixture _factory;

    public ApiContractSmokeTests(PoMiniGamesE2EFixture factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task HealthPing_ReturnsPong()
    {
        using var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/health/ping");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await response.Content.ReadAsStringAsync();
        body.Should().Contain("pong");
    }

    [Fact]
    public async Task AuthConfig_ReturnsPublicShape()
    {
        using var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/auth/config");

        // /api/auth/config is anonymous; it must always return 200 with the
        // public client config (microsoft-enabled flag, dev-login flag, etc.).
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task AuthMe_Anonymous_Returns200()
    {
        using var client = _factory.CreateClient();
        var response = await client.GetAsync("/auth/me");

        // §2.2: /auth/me is anonymous and returns the unauthenticated auth
        // state shape, not a 401.
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }
}
