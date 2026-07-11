namespace PoMiniGames.Domain.Models;

/// <summary>A single PoClick rhythm-trainer result. Higher score is better.</summary>
public sealed record PoClickHighScore
{
    public string PlayerName { get; init; } = string.Empty;
    /// <summary>Normalized accuracy score 0-100 (see PoClickPage.FinishGame).</summary>
    public double Score { get; init; }
    public int Bpm { get; init; }
    public int DurationSeconds { get; init; }
    public string Date { get; init; } = string.Empty;
}
