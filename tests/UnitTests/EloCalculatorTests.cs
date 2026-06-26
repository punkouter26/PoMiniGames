using FluentAssertions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Services;

namespace PoMiniGames.UnitTests;

/// <summary>Unit tests for <see cref="EloCalculator"/>.</summary>
public sealed class EloCalculatorTests
{
    private static readonly EloCalculator _calculator = new(new EloOptions());

    // ─── Compute: zero games ──────────────────────────────────────────────

    [Fact]
    public void Compute_ReturnsReferenceElo_WhenNoGamesPlayed()
    {
        var ds = new DifficultyStats();
        _calculator.Compute(ds, 800).Should().Be(1000);
    }

    // ─── Compute: Easy AI (virtual ELO 800) ──────────────────────────────

    [Fact]
    public void Compute_Easy_Win_IncreasesEloSlightly()
    {
        var ds = new DifficultyStats { Wins = 1, TotalGames = 1 };
        var elo = _calculator.Compute(ds, 800);
        elo.Should().BeGreaterThan(1000, "winning against weak AI yields a small gain");
    }

    [Fact]
    public void Compute_Easy_Loss_DecreasesEloHeavily()
    {
        var ds = new DifficultyStats { Losses = 1, TotalGames = 1 };
        var elo = _calculator.Compute(ds, 800);
        elo.Should().BeLessThan(1000, "losing to weak AI is heavily penalised");
    }

    [Fact]
    public void Compute_Easy_Draw_DecreasesElo()
    {
        var ds = new DifficultyStats { Draws = 1, TotalGames = 1 };
        var elo = _calculator.Compute(ds, 800);
        elo.Should().BeLessThan(1000, "drawing against weak AI is still penalised");
    }

    // ─── Compute: Medium AI (virtual ELO 1200) ───────────────────────────

    [Fact]
    public void Compute_Medium_Win_IncreasesEloMoreThanEasyWin()
    {
        var easyWin = new DifficultyStats { Wins = 1, TotalGames = 1 };
        var mediumWin = new DifficultyStats { Wins = 1, TotalGames = 1 };

        _calculator.Compute(mediumWin, 1200).Should()
            .BeGreaterThan(_calculator.Compute(easyWin, 800),
                "beating harder AI yields a larger reward");
    }

    [Fact]
    public void Compute_Medium_Draw_IncreasesElo()
    {
        var ds = new DifficultyStats { Draws = 1, TotalGames = 1 };
        var elo = _calculator.Compute(ds, 1200);
        elo.Should().BeGreaterThan(1000, "drawing against medium AI is a positive result");
    }

    // ─── Compute: Hard AI (virtual ELO 1600) ─────────────────────────────

    [Fact]
    public void Compute_Hard_Win_YieldsHighestGain()
    {
        var ds = new DifficultyStats { Wins = 1, TotalGames = 1 };
        var elo = _calculator.Compute(ds, 1600);
        elo.Should().BeGreaterThan(1000, "beating hard AI yields highest gain");
    }

    [Fact]
    public void Compute_Hard_Loss_IsNearlyNeutral()
    {
        var ds = new DifficultyStats { Losses = 1, TotalGames = 1 };
        var elo = _calculator.Compute(ds, 1600);
        // Losing to hard AI barely costs ELO (expected to lose anyway)
        elo.Should().BeCloseTo(1000, delta: 5);
    }

    // ─── Floor ───────────────────────────────────────────────────────────

    [Fact]
    public void Compute_EloIsFloored_AtZero()
    {
        // 100 losses to easy AI: would go deeply negative without the floor
        var ds = new DifficultyStats { Losses = 100, TotalGames = 100 };
        _calculator.Compute(ds, 800).Should().Be(0);
    }

    // ─── Determinism ─────────────────────────────────────────────────────

    [Fact]
    public void Compute_IsDeterministic_ForSameInput()
    {
        var ds = new DifficultyStats { Wins = 5, Draws = 2, Losses = 3, TotalGames = 10 };
        var first = _calculator.Compute(ds, 1200);
        var second = _calculator.Compute(ds, 1200);
        first.Should().Be(second);
    }

    // ─── ApplyAll ────────────────────────────────────────────────────────

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
}
