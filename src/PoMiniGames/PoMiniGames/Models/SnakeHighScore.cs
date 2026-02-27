namespace PoMiniGames.Models;

/// <summary>A single PoSnakeGame high-score entry stored in SQLite.</summary>
public sealed record SnakeHighScore
{
    public string Initials { get; init; } = string.Empty;
    public int Score { get; init; }
    public string Date { get; init; } = string.Empty;
    public float GameDuration { get; init; } = 30f;
    public int SnakeLength { get; init; }
    public int FoodEaten { get; init; }
}
