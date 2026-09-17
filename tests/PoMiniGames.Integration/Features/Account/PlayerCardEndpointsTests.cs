using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using PoMiniGames.Domain.Models;
using Xunit;

namespace PoMiniGames.Integration.Features.Account;

public sealed class PlayerCardEndpointsTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly HttpClient _client;

    public PlayerCardEndpointsTests(TestWebApplicationFactory factory)
    {
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task GetPlayerCard_ReturnsOk_WithValidDtoStructure()
    {
        var response = await _client.GetAsync("/api/player/card?name=TestSpeedster");
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var card = await response.Content.ReadFromJsonAsync<PlayerCardDto>();
        card.Should().NotBeNull();
        card!.DisplayName.Should().Be("TestSpeedster");
        card.Mmr.Should().Be(OnlineMmrCalculator.SeedMmr);
        card.Tier.Should().Be(OnlineRankTier.Silver);
        card.TierName.Should().Be("Silver");
        card.TierColorHex.Should().Be("#c0c0c0");
        card.Initials.Should().Be("TE");
    }

    [Fact]
    public async Task GetPlayerCardSvg_ReturnsOk_WithValidSvgXml()
    {
        var response = await _client.GetAsync("/api/player/card/svg?name=CyberRacer");
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Content.Headers.ContentType?.MediaType.Should().Be("image/svg+xml");

        var svg = await response.Content.ReadAsStringAsync();
        svg.Should().StartWith("<svg");
        svg.TrimEnd().Should().EndWith("</svg>");
        svg.Should().Contain("CyberRacer");
        svg.Should().Contain("COMPETITIVE LICENSE");
        svg.Should().Contain("MMR");
        svg.Should().Contain("SILVER TIER");
    }

    [Fact]
    public async Task GetOnlineMmrLeaderboard_ReturnsOk_WithLeaderboardDto()
    {
        var response = await _client.GetAsync("/api/leaderboards/online-mmr");
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var board = await response.Content.ReadFromJsonAsync<GameLeaderboardDto>();
        board.Should().NotBeNull();
        board!.GameKey.Should().Be("online-mmr");
        board.Title.Should().Be("Online MMR");
        board.Unit.Should().Be("MMR");
        board.HigherIsBetter.Should().BeTrue();
    }
}
