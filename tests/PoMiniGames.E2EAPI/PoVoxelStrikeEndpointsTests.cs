using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace PoMiniGames.E2EAPI;

/// <summary>
/// BFF contract for the PoVoxelStrike slice at the anonymous surface this tier covers
/// (authed ratchet semantics follow the Marble/PoSports descriptor pattern; the descriptor
/// itself is structurally guarded by the Unit tier's reflective HighScoreDescriptorTests):
/// the asset routes are anonymous and content-addressed, the run routes are auth-gated,
/// and the unified leaderboard exposes the Voxel Strike board anonymously.
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public class PoVoxelStrikeEndpointsTests
{
    private readonly PoMiniGamesE2EFixture _factory;

    public PoVoxelStrikeEndpointsTests(PoMiniGamesE2EFixture factory) => _factory = factory;

    [Fact]
    public async Task AssetRoutes_ServeTheManifestAnonymously_AndPinTheHashShape()
    {
        using var client = _factory.CreateClient();

        // Manifest: anonymous 200 with a JSON array (startup ingestion may still be
        // converting, so the array being populated is not part of the contract here).
        var manifest = await client.GetAsync("/api/povoxelstrike/assets");
        manifest.StatusCode.Should().Be(HttpStatusCode.OK);
        using var doc = JsonDocument.Parse(await manifest.Content.ReadAsStringAsync());
        doc.RootElement.ValueKind.Should().Be(JsonValueKind.Array);

        // The hash is the only client-supplied path component that nears the filesystem:
        // anything that is not 64 lowercase hex must be rejected before the handler (400),
        // and a well-formed but unknown hash is a 404 — never a traversal, never a 500.
        (await client.GetAsync("/api/povoxelstrike/assets/not-a-hash"))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await client.GetAsync($"/api/povoxelstrike/assets/{new string('a', 64)}"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

        // When ingestion has produced assets (the repo drop folder ships samples), the
        // payload must be the immutable content-addressed binary: PVX1 magic + a
        // cache-forever header, so the client Cache API layer never revalidates.
        var entries = doc.RootElement.EnumerateArray().ToList();
        if (entries.Count > 0)
        {
            var url = entries[0].GetProperty("url").GetString();
            var payload = await client.GetAsync("/" + url);
            payload.StatusCode.Should().Be(HttpStatusCode.OK);
            payload.Headers.CacheControl!.ToString().Should().Contain("immutable");
            var bytes = await payload.Content.ReadAsByteArrayAsync();
            bytes.Take(4).Should().Equal("PVX1"u8.ToArray());
        }
    }

    [Fact]
    public async Task RunRoutes_AreAuthGated()
    {
        using var client = _factory.CreateClient();

        // Score READ and WRITE both sit inside the authenticated game API group —
        // anonymous requests must bounce, never 404 (the route exists) and never 200.
        var get = await client.GetAsync("/api/povoxelstrike/highscores");
        get.StatusCode.Should().BeOneOf(HttpStatusCode.Unauthorized, HttpStatusCode.Redirect, HttpStatusCode.Found);

        var post = await client.PostAsJsonAsync("/api/povoxelstrike/highscores", new
        {
            score = 100,
            survivalSeconds = 12.5,
            kills = 2,
            bruteKills = 0,
            crushKills = 1,
            voxelsDestroyed = 500,
        });
        post.StatusCode.Should().BeOneOf(HttpStatusCode.Unauthorized, HttpStatusCode.Redirect, HttpStatusCode.Found);
    }

    [Fact]
    public async Task UnifiedLeaderboard_ServesTheVoxelStrikeBoard_Anonymously()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/leaderboards/povoxelstrike");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await response.Content.ReadAsStringAsync();
        body.Should().Contain("povoxelstrike").And.Contain("Voxel Strike",
            because: "the Voxel Strike board must be part of the unified leaderboard read-model");
    }
}
