using System.Net;
using System.Net.Http.Json;
using PoMiniGames.TestUtilities;

namespace PoMiniGames.E2EAPI;

[Collection(PoMiniGamesE2ECollection.Name)]
public sealed class PoRacerContractTests(PoMiniGamesE2EFixture fixture)
{
    [Fact]
    public async Task LeaderboardIsPublic_AndScoreSubmissionRequiresAuthentication()
    {
        using var client = fixture.CreateClient();
        var board = await client.GetAsync("/api/leaderboards/poracer");
        board.StatusCode.Should().Be(HttpStatusCode.OK);
        (await board.Content.ReadAsStringAsync()).Should().Contain("Best lap");
        await client.ArmAntiforgeryAsync();
        var write = await client.PostAsJsonAsync("/api/poracer/scores", new { totalTimeSeconds = 42, finalPosition = 1, trackId = "circuit" });
        write.StatusCode.Should().BeOneOf(HttpStatusCode.Unauthorized, HttpStatusCode.Redirect);
    }
}
