using System.Net;
using System.Net.Http.Json;

namespace PoMiniGames.E2EAPI;

/// <summary>
/// BFF contract for the PoSports slice at the anonymous surface this tier covers
/// (the e2e-api fixture deliberately has no default auth scheme — authed storage
/// semantics live in the integration tier's PoSportsHighScoreTests): the high-score
/// routes are auth-gated, and the unified leaderboard exposes the Sports board
/// anonymously.
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public class PoSportsHighScoresTests
{
    private readonly PoMiniGamesE2EFixture _factory;

    public PoSportsHighScoresTests(PoMiniGamesE2EFixture factory) => _factory = factory;

    [Fact]
    public async Task HighScoreRoutes_AreAuthGated()
    {
        using var client = _factory.CreateClient();

        // Score READ and WRITE both sit inside the authenticated game API group —
        // anonymous requests must bounce, never 404 (the route exists) and never 200.
        var get = await client.GetAsync("/api/posports/highscores");
        get.StatusCode.Should().BeOneOf(HttpStatusCode.Unauthorized, HttpStatusCode.Redirect, HttpStatusCode.Found);

        var post = await client.PostAsJsonAsync("/api/posports/highscores", new
        {
            playerName = "Anon",
            sprintSeconds = 15.0,
            hurdlesSeconds = 20.0,
            totalTimeSeconds = 35.0,
            character = "mom",
        });
        post.StatusCode.Should().BeOneOf(HttpStatusCode.Unauthorized, HttpStatusCode.Redirect, HttpStatusCode.Found);
    }

    [Fact]
    public async Task UnifiedLeaderboard_ServesTheSportsBoard_Anonymously()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/leaderboards/posports");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await response.Content.ReadAsStringAsync();
        body.Should().Contain("posports").And.Contain("Sports",
            because: "the Sports board must be part of the unified leaderboard read-model");
    }
}
