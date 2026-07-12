namespace PoMiniGames.Domain.Models;

/// <summary>A single PoReflex run: the average reaction time over 6 bars, in milliseconds. Lower is better.</summary>
public sealed record PoReflexHighScore
{
    public string PlayerName { get; init; } = string.Empty;
    /// <summary>Average reaction time in milliseconds across the 6 bars (lower wins).</summary>
    public double Score { get; init; }
    /// <summary>Fastest single-bar reaction of the run, in milliseconds.</summary>
    public double BestReactionMs { get; init; }
    public string Date { get; init; } = string.Empty;
}
