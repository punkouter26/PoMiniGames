using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PoMiniGames.Infrastructure.Services;
using PoMiniGames.Shared.Games;
using Xunit;

namespace PoMiniGames.Integration.Features.PoRacer;

public sealed class PoRacerScoreTests(TestWebApplicationFactory factory) : IClassFixture<TestWebApplicationFactory>
{
    [Fact]
    public async Task BestLap_RetryIsIdempotent_AndInvalidTrackIsRejected()
    {
        factory.DockerAvailable.Should().BeTrue("this persistence test requires Azurite");
        using var client = await factory.CreateClient().ArmAntiforgeryAsync();
        var score = new PoRacerScoreDto { PlayerDisplayName = "Forged", BestLapSeconds = 42.125, FinalPosition = 2, TrackId = "circuit", GameCode = "solo-test" };
        (await client.PostAsJsonAsync("/api/poracer/scores", score)).StatusCode.Should().Be(HttpStatusCode.Created);
        (await client.PostAsJsonAsync("/api/poracer/scores", score)).StatusCode.Should().Be(HttpStatusCode.Created);
        var storage = factory.Services.GetRequiredService<StorageService>();
        var rows = await storage.GetPoRacerHighScoresAsync(50, "circuit");
        rows.Where(r => r.TotalTimeSeconds == score.BestLapSeconds).Should().ContainSingle().Which.PlayerName.Should().NotBe("Forged");
        score.TrackId = "removed-track";
        (await client.PostAsJsonAsync("/api/poracer/scores", score)).StatusCode.Should().Be(HttpStatusCode.BadRequest);
        score.TrackId = "circuit";
        score.BestLapSeconds = 0;
        (await client.PostAsJsonAsync("/api/poracer/scores", score)).StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
}
