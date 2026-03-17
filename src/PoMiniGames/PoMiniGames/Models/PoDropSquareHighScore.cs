namespace PoMiniGames.Models;

/// <summary>A single PoDropSquare high-score entry stored in SQLite.</summary>
public sealed record PoDropSquareHighScore
{
    public string PlayerInitials { get; init; } = string.Empty;
    public double SurvivalTime { get; init; }
    public string Date { get; init; } = string.Empty;
    public string? PlayerName { get; init; }
}