using System.Net;

namespace PoMiniGames.E2EAPI.Features.PoCabinet;

/// <summary>
/// The lobby and race hubs are mapped and auth-gated at the route-group layer: their
/// <c>/negotiate</c> rejects an anonymous handshake (401) instead of letting an unattributed
/// player take a lobby seat. (A missing hub would answer 404.) The two-browser lobby → race
/// hand-off needs a live Kestrel host and is covered in the E2E-UI tier; the per-tick wire budget
/// is a Unit scenario.
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public sealed class PoCabinetRaceHubContractTests(PoMiniGamesE2EFixture fixture)
{
    [Theory]
    [InlineData("/pocabinet/lobby-hub/negotiate")]
    [InlineData("/pocabinet/race-hub/negotiate")]
    public async Task HubNegotiate_IsMapped_AndAuthGated(string negotiateUrl)
    {
        using var client = fixture.CreateClient();
        var negotiate = await client.PostAsync(negotiateUrl, content: null);
        negotiate.StatusCode.Should().Be(HttpStatusCode.Unauthorized,
            $"the {negotiateUrl} endpoint must exist and reject anonymous negotiations");
    }
}
