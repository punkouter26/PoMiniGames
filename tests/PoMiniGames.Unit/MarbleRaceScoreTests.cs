using FluentAssertions;
using PoMiniGames.Domain.Models;

namespace PoMiniGames.Unit;

/// <summary>
/// Unit tests for <see cref="MarbleRaceScore"/> — the type that makes an out-of-range PoMarbleRace
/// score unrepresentable rather than merely rejected at one endpoint.
/// </summary>
/// <remarks>
/// The accept and reject cases were two theories; they are one now (2026-09-14, to free a
/// Unit slot for PoEcosystem's chronicler) — same rows, with the expectation as a column.
/// </remarks>
public sealed class MarbleRaceScoreTests
{
    [Theory]
    [InlineData(0, true)]                // a scoreless run is legitimate
    [InlineData(1, true)]
    [InlineData(1_000_000, true)]        // the ceiling itself is valid
    [InlineData(-1, false)]              // negative
    [InlineData(1_000_001, false)]       // just past the ceiling
    [InlineData(int.MaxValue, false)]    // the tampered submission that would own the board forever
    [InlineData(int.MinValue, false)]
    public void TryCreate_ChecksTheRange(int value, bool accepted)
    {
        MarbleRaceScore.TryCreate(value, out var score).Should().Be(accepted);
        score.Value.Should().Be(accepted ? value : 0, accepted ? "an accepted score keeps its value" : "a rejected score must not leak a usable value to the caller");
    }

    [Theory]
    [InlineData(-5, 0)]
    [InlineData(42, 42)]
    [InlineData(int.MaxValue, 1_000_000)]
    public void Clamp_BoundsTrustedValues(int value, int expected) =>
        MarbleRaceScore.Clamp(value).Value.Should().Be(expected);
}
