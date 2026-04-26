namespace PoMiniGamesClient.Models;

public enum Difficulty
{
    Easy,
    Medium,
    Hard
}

public enum GameResult
{
    InProgress,
    Win,
    Loss,
    Draw
}

public class DifficultyStats
{
    public int Wins { get; set; }
    public int Losses { get; set; }
    public int Draws { get; set; }
    public int TotalGames { get; set; }
    public int WinStreak { get; set; }
    public double WinRate { get; set; }
    public int EloRating { get; set; } = 1000;
}

public class PlayerStats
{
    public string PlayerId { get; set; } = "";
    public string PlayerName { get; set; } = "";
    public DifficultyStats Easy { get; set; } = new();
    public DifficultyStats Medium { get; set; } = new();
    public DifficultyStats Hard { get; set; } = new();
    public int TotalWins { get; set; }
    public int TotalLosses { get; set; }
    public int TotalDraws { get; set; }
    public int TotalGames { get; set; }
    public double WinRate { get; set; }
    public string CreatedAt { get; set; } = "";
    public string UpdatedAt { get; set; } = "";
}

public class PlayerStatsDto
{
    public string Name { get; set; } = "";
    public string Game { get; set; } = "";
    public PlayerStats Stats { get; set; } = new();
}

public class SnakeHighScore
{
    public string Initials { get; set; } = "";
    public int Score { get; set; }
    public string Date { get; set; } = "";
    public int GameDuration { get; set; }
    public int SnakeLength { get; set; }
    public int FoodEaten { get; set; }
}