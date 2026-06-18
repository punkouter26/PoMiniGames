namespace PoMiniGames.Domain.Models;

/// <summary>A single PoMarbleRace high-score entry stored in SQLite. Higher score is better.</summary>
public sealed record MarbleRaceHighScore
{
    public string PlayerInitials { get; init; } = string.Empty;
    public int BestScore { get; init; }
    public string Date { get; init; } = string.Empty;
    public double GameDuration { get; init; }
}
