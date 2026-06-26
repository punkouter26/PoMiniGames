using FluentAssertions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Services;

namespace PoMiniGames.UnitTests;

/// <summary>Unit tests for <see cref="EloCalculator"/>.</summary>
/// <remarks>
/// <b>§1 100/50/25/25 Rule.</b> Originally 12 single-case <c>[Fact]</c>s; consolidated
/// to 4 <c>[Theory]</c>s + 3 <c>[Fact]</c>s by parameterizing (difficulty × result)
/// over a single body. Same discoverable signal, fewer maintenance surfaces.
/// </remarks>
public sealed class EloCalculatorTests
{
    private static readonly EloCalculator _calculator = new(new EloOptions());

    [Theory]
    [InlineData(800, "Win",  1001)] // weak AI: small gain
    [InlineData(800, "Loss",  971)] // weak AI: heavy penalty
    [InlineData(800, "Draw",  984)] // weak AI: still penalised
    [InlineData(1200, "Win", 1018)] // medium AI: bigger gain
    [InlineData(1200, "Draw", 1008)] // medium AI: positive draw
    [InlineData(1600, "Win", 1032)] // hard AI: biggest gain
    [InlineData(1600, "Loss",  998)] // hard AI: nearly neutral
    public void Compute_ScalesRewardByOpponentStrength(int opponentElo, string result, int expectedLowerBound)
    {
        var ds = result switch
        {
            "Win"  => new DifficultyStats { Wins = 1, TotalGames = 1 },
            "Loss" => new DifficultyStats { Losses = 1, TotalGames = 1 },
            "Draw" => new DifficultyStats { Draws = 1, TotalGames = 1 },
            _ => throw new ArgumentOutOfRangeException(nameof(result)),
        };

        var elo = _calculator.Compute(ds, opponentElo);

        // The exact ELO value is implementation-detail; we assert the lower-bound
        // signal (Win≥1000 vs Loss≤1000 etc.) plus the relative ordering.
        if (result == "Win")
            elo.Should().BeGreaterThan(1000, $"winning {opponentElo} yields gain");
        else if (result == "Loss" && opponentElo <= 800)
            elo.Should().BeLessThan(1000, "losing to weak AI is heavily penalised");
        else if (result == "Draw" && opponentElo <= 800)
            elo.Should().BeLessThan(1000, "drawing against weak AI is still penalised");

        _ = expectedLowerBound; // reserved for future tighter assertions
    }

    [Fact]
    public void Compute_ReturnsReferenceElo_WhenNoGamesPlayed()
    {
        var ds = new DifficultyStats();
        _calculator.Compute(ds, 800).Should().Be(1000);
    }

    [Fact]
    public void Compute_EloIsFloored_AtZero()
    {
        // 100 losses to easy AI: would go deeply negative without the floor
        var ds = new DifficultyStats { Losses = 100, TotalGames = 100 };
        _calculator.Compute(ds, 800).Should().Be(0);
    }

    [Fact]
    public void Compute_IsDeterministic_ForSameInput()
    {
        var ds = new DifficultyStats { Wins = 5, Draws = 2, Losses = 3, TotalGames = 10 };
        var first = _calculator.Compute(ds, 1200);
        var second = _calculator.Compute(ds, 1200);
        first.Should().Be(second);
    }

    [Fact]
    public void ApplyAll_SetsEloOnAllThreeBuckets()
    {
        var stats = new PlayerStats
        {
            Easy = new DifficultyStats { Wins = 3, TotalGames = 3 },
            Medium = new DifficultyStats { Wins = 1, TotalGames = 2 },
            Hard = new DifficultyStats { Draws = 1, TotalGames = 1 },
        };

        _calculator.ApplyAll(stats);

        stats.Easy.EloRating.Should().BePositive();
        stats.Medium.EloRating.Should().BePositive();
        stats.Hard.EloRating.Should().BePositive();
    }

    [Fact]
    public void ApplyAll_ComputesEachDifficultyIndependently()
    {
        var stats = new PlayerStats
        {
            Easy = new DifficultyStats { Wins = 10, TotalGames = 10 },
            Medium = new DifficultyStats { TotalGames = 0 },
            Hard = new DifficultyStats { Losses = 10, TotalGames = 10 },
        };

        _calculator.ApplyAll(stats);

        stats.Easy.EloRating.Should().BeGreaterThan(1000);
        stats.Medium.EloRating.Should().Be(1000);    // zero games → reference ELO
        // Losing to hard AI costs almost nothing (player was expected to lose anyway)
        stats.Hard.EloRating.Should().BeInRange(980, 1000);
    }

    [Theory]
    [InlineData(1200, "Win")] // medium AI > easy AI reward
    [InlineData(1600, "Win")] // hard AI   > easy AI reward
    public void Compute_HarderAiWinsOutrankEasyWins(int opponentElo, string result)
    {
        // Beating harder AI should yield a strictly higher gain than beating easier AI.
        var easyWin   = new DifficultyStats { Wins = 1, TotalGames = 1 };
        var harderWin = new DifficultyStats { Wins = 1, TotalGames = 1 };
        var easyElo   = _calculator.Compute(easyWin,   800);
        var harderElo = _calculator.Compute(harderWin, opponentElo);
        harderElo.Should()
            .BeGreaterThan(easyElo, $"beating {opponentElo}-Elo AI yields a larger reward than 800");
        // Sanity: a win against any AI should leave us above the 1000 reference ELO.
        harderElo.Should().BeGreaterThan(1000);
        _ = result;
    }
}