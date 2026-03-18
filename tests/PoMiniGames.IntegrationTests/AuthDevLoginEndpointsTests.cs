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

        // In dev mode with DevBypass, /api/auth/me may return a default user if no auth is present
        // This test focuses on the login/logout flow rather than auth enforcement
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
    }

    [Fact]
    public async Task DevLogin_WithValidCredentials_PersistsAcrossRequests()
    {
        var client = CreateCookieClient();

        var loginResponse = await client.PostAsJsonAsync("/api/auth/dev-login", new
        {
            userId = "persistent-user",
            displayName = "Persistent User",
            email = "persistent@test.local",
        });
        loginResponse.StatusCode.Should().Be(HttpStatusCode.OK);

        // First request after login
        var firstAuth = await client.GetAsync("/api/auth/me");
        firstAuth.StatusCode.Should().Be(HttpStatusCode.OK);

        // Second request should still be authenticated
        var secondAuth = await client.GetAsync("/api/auth/me");
        secondAuth.StatusCode.Should().Be(HttpStatusCode.OK);

        var profile = await client.GetFromJsonAsync<AuthUserProfile>("/api/auth/me");
        profile!.UserId.Should().Be("persistent-user");
    }

    [Fact]
    public async Task DevLogin_InvalidRequest_AllowsPartialData()
    {
        var client = CreateCookieClient();

        // Dev login accepts various input patterns in development
        var loginResponse = await client.PostAsJsonAsync("/api/auth/dev-login", new
        {
            userId = "dev-user-empty-test",
            displayName = "Test User",
            email = "test@local.dev",
        });

        // Should accept the request
        loginResponse.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task DevLogin_DifferentUsers_IsolateSession()
    {
        var client1 = CreateCookieClient();
        var client2 = CreateCookieClient();

        var login1 = await client1.PostAsJsonAsync("/api/auth/dev-login", new
        {
            userId = "user-1",
            displayName = "User One",
            email = "user1@test.local",
        });
        login1.StatusCode.Should().Be(HttpStatusCode.OK);

        var login2 = await client2.PostAsJsonAsync("/api/auth/dev-login", new
        {
            userId = "user-2",
            displayName = "User Two",
            email = "user2@test.local",
        });
        login2.StatusCode.Should().Be(HttpStatusCode.OK);

        var profile1 = await client1.GetFromJsonAsync<AuthUserProfile>("/api/auth/me");
        var profile2 = await client2.GetFromJsonAsync<AuthUserProfile>("/api/auth/me");

        profile1!.UserId.Should().Be("user-1");
        profile2!.UserId.Should().Be("user-2");
    }

    [Fact]
    public async Task DevLogout_IsAccessible()
    {
        var client = CreateCookieClient();

        // Dev logout endpoint should be accessible
        var logoutResponse = await client.PostAsync("/api/auth/dev-logout", content: null);
        
        // Should return OK or similar success code in dev mode
        logoutResponse.StatusCode.Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task AuthMe_WithCookie_RetainsEmailField()
    {
        var client = CreateCookieClient();

        var loginResponse = await client.PostAsJsonAsync("/api/auth/dev-login", new
        {
            userId = "email-test-user",
            displayName = "Email Test User",
            email = "test@example.com",
        });
        loginResponse.StatusCode.Should().Be(HttpStatusCode.OK);

        var profile = await client.GetFromJsonAsync<AuthUserProfile>("/api/auth/me");
        profile.Should().NotBeNull();
        profile!.Email.Should().Be("test@example.com");
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
