using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Domain.Models;
using PoMiniGames.TestUtilities;

namespace PoMiniGames.Integration;

/// <summary>
/// PoMule's Net Worth board against a real Azurite container: a saved match comes back with
/// its species and colony fate, the board ranks richest first, and a player's row only ever
/// ratchets upward.
/// </summary>
public sealed class PoMuleHighScoreTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly TestWebApplicationFactory _factory;

    public PoMuleHighScoreTests(TestWebApplicationFactory factory) => _factory = factory;

    private static PoMuleHighScore Match(string player, int netWorth, bool survived = true) => new()
    {
        PlayerName = player,
        UserId = $"user-{player}",
        NetWorth = netWorth,
        Species = "Humanoid Settler",
        ColonySurvived = survived,
    };

    [Fact]
    public async Task SaveGetRankAndRatchet_RoundTrip()
    {
        if (!_factory.DockerAvailable) return;
        var storage = _factory.Services.GetRequiredService<IStorageService>();

        await storage.SavePoMuleHighScoreAsync(Match("Mule Rich", 18_500));
        await storage.SavePoMuleHighScoreAsync(Match("Mule Poor", 9_200, survived: false));

        var board = await storage.GetPoMuleHighScoresAsync(100);
        var rich = board.Single(s => s.PlayerName == "Mule Rich");
        rich.Should().BeEquivalentTo(Match("Mule Rich", 18_500), o => o.Excluding(s => s.AchievedAtUtc));
        rich.AchievedAtUtc.Should().BeCloseTo(DateTimeOffset.UtcNow, TimeSpan.FromMinutes(1));
        board.Single(s => s.PlayerName == "Mule Poor").ColonySurvived.Should().BeFalse();
        board.Select(s => s.NetWorth).Should().BeInDescendingOrder();

        // A poorer match must not overwrite the best one; a richer one replaces it.
        await storage.SavePoMuleHighScoreAsync(Match("Mule Rich", 12_000));
        (await storage.GetPoMuleHighScoresAsync(100)).Single(s => s.PlayerName == "Mule Rich").NetWorth.Should().Be(18_500);
        await storage.SavePoMuleHighScoreAsync(Match("Mule Rich", 21_000));
        (await storage.GetPoMuleHighScoresAsync(100)).Single(s => s.PlayerName == "Mule Rich").NetWorth.Should().Be(21_000);

        // A tampered number is clamped to the ceiling rather than stored as sent.
        var clamped = await storage.SavePoMuleHighScoreAsync(Match("Mule Cheat", int.MaxValue));
        clamped.NetWorth.Should().Be(PoMuleHighScore.MaxNetWorth);
    }
}
