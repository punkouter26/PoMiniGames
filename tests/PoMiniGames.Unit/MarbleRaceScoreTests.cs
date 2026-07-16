using FluentAssertions;
using PoMiniGames.Domain.Models;

namespace PoMiniGames.Unit;

/// <summary>
/// Unit tests for <see cref="MarbleRaceScore"/> — the type that makes an out-of-range PoMarbleRace
/// score unrepresentable rather than merely rejected at one endpoint.
/// </summary>
public sealed class MarbleRaceScoreTests
{
    [Theory]
    [InlineData(0)]                      // a scoreless run is legitimate
    [InlineData(1)]
    [InlineData(1_000_000)]              // the ceiling itself is valid
    public void TryCreate_AcceptsScoresInRange(int value)
    {
        MarbleRaceScore.TryCreate(value, out var score).Should().BeTrue();
        score.Value.Should().Be(value);
    }

    [Theory]
    [InlineData(-1)]                     // negative
    [InlineData(1_000_001)]              // just past the ceiling
    [InlineData(int.MaxValue)]           // the tampered submission that would own the board forever
    [InlineData(int.MinValue)]
    public void TryCreate_RejectsScoresOutOfRange(int value)
    {
        MarbleRaceScore.TryCreate(value, out var score).Should().BeFalse();
        score.Value.Should().Be(0, "a rejected score must not leak a usable value to the caller");
    }

    [Theory]
    [InlineData(-5, 0)]
    [InlineData(42, 42)]
    [InlineData(int.MaxValue, 1_000_000)]
    public void Clamp_BoundsTrustedValues(int value, int expected) =>
        MarbleRaceScore.Clamp(value).Value.Should().Be(expected);
}
