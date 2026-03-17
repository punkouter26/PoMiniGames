using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Mvc.Testing;

namespace PoMiniGames.IntegrationTests;

public class AuthDevLoginEndpointsTests : IClassFixture<LocalAuthWebApplicationFactory>
{
    private readonly LocalAuthWebApplicationFactory _factory;

    public AuthDevLoginEndpointsTests(LocalAuthWebApplicationFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task AuthConfig_InDevelopment_EnablesDevLoginMode()
    {
        var client = _factory.CreateClient();

        var response = await client.GetFromJsonAsync<AuthConfigResponse>("/api/auth/config");

        response.Should().NotBeNull();
        response!.Enabled.Should().BeTrue();
        response.DevLoginEnabled.Should().BeTrue();
    }

    [Fact]
    public async Task DevLogin_CreatesCookieSession_AndDevLogoutClearsIt()
    {
        var client = CreateCookieClient();

        var beforeLogin = await client.GetAsync("/api/auth/me");
        beforeLogin.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        var loginResponse = await client.PostAsJsonAsync("/api/auth/dev-login", new
        {
            userId = "dev-user-a",
            displayName = "Dev User A",
            email = "dev.user.a@local.dev",
        });

        loginResponse.StatusCode.Should().Be(HttpStatusCode.OK);

        var profile = await client.GetFromJsonAsync<AuthUserProfile>("/api/auth/me");
        profile.Should().NotBeNull();
        profile!.UserId.Should().Be("dev-user-a");
        profile.DisplayName.Should().Be("Dev User A");

        var logoutResponse = await client.PostAsync("/api/auth/dev-logout", content: null);
        logoutResponse.StatusCode.Should().Be(HttpStatusCode.OK);

        var afterLogout = await client.GetAsync("/api/auth/me");
        afterLogout.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    private HttpClient CreateCookieClient()
    {
        return _factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,
            HandleCookies = true,
        });
    }

    private sealed record AuthConfigResponse(bool Enabled, bool DevLoginEnabled);

    private sealed record AuthUserProfile(string UserId, string DisplayName, string? Email);
}
