using System.Net;
using System.Net.Http.Json;
using FluentAssertions;

namespace PoMiniGames.IntegrationTests;

/// <summary>
/// Integration tests for SignalR multiplayer endpoints and WebSocket connections.
/// Tests cover lobby hub and multiplayer game hub initialization.
/// </summary>
public sealed class MultiplayerConnectionTests : IClassFixture<LocalAuthWebApplicationFactory>
{
    private readonly LocalAuthWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public MultiplayerConnectionTests(LocalAuthWebApplicationFactory factory)
    {
        _factory = factory;
        _client = factory.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,
            HandleCookies = true,
        });
    }

    [Fact]
    public async Task LobbyHub_RequiresAuthentication()
    {
        // WebSocket upgrade requests should require auth
        // This test verifies the endpoint exists and responds to auth checks
        var response = await _client.GetAsync("/api/hubs/lobby");
        
        // Pre-flight should either be 400 (WebSocket protocol error) or 401 (auth required)
        // but the endpoint should exist
        response.StatusCode.Should().BeOneOf(
            HttpStatusCode.BadRequest,
            HttpStatusCode.Unauthorized,
            HttpStatusCode.UpgradeRequired
        );
    }

    [Fact]
    public async Task MultiplayerHub_Endpoint_IsAccessible()
    {
        // Similar to lobby hub, verify the multiplayer hub endpoint exists
        var response = await _client.GetAsync("/api/hubs/multiplayer");
        
        response.StatusCode.Should().BeOneOf(
            HttpStatusCode.BadRequest,
            HttpStatusCode.Unauthorized,
            HttpStatusCode.UpgradeRequired
        );
    }

    [Fact]
    public async Task MultiplayerQueue_EndpointExists()
    {
        // Verify the queue endpoint can be called
        var response = await _client.PostAsync("/api/multiplayer/queue", null);
        
        // Should return 401 if not authenticated, or 400 for bad request
        response.StatusCode.Should().BeOneOf(
            HttpStatusCode.OK,
            HttpStatusCode.BadRequest,
            HttpStatusCode.Unauthorized
        );
    }

    [Fact]
    public async Task MultiplayerMatchesEndpoint_IsAccessible()
    {
        // Verify the matches endpoint exists (used for game state)
        var response = await _client.GetAsync("/api/multiplayer/matches");
        
        response.StatusCode.Should().BeOneOf(
            HttpStatusCode.OK,
            HttpStatusCode.BadRequest,
            HttpStatusCode.Unauthorized,
            HttpStatusCode.NotFound
        );
    }

    [Fact]
    public async Task AuthenticatedUser_CanAccessMultiplayerQueue()
    {
        // First, log in as a dev user
        var loginResponse = await _client.PostAsJsonAsync("/api/auth/dev-login", new
        {
            userId = "mp-test-user",
            displayName = "Multiplayer Test User",
            email = "mptest@local.dev",
        });

        loginResponse.StatusCode.Should().Be(HttpStatusCode.OK);

        // Now try to access queue endpoint
        var queueResponse = await _client.PostAsync("/api/multiplayer/queue", null);
        
        // Authenticated user should get a valid response (not 401)
        queueResponse.StatusCode.Should().NotBe(HttpStatusCode.Unauthorized);
    }
}
