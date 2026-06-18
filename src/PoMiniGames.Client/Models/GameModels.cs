namespace PoMiniGamesClient.Models;

public class DifficultyStats
{
    public int Wins { get; set; }
    public int Losses { get; set; }
    public int Draws { get; set; }
    public int TotalGames => Wins + Losses + Draws;
    public int WinStreak { get; set; }
    public double WinRate => TotalGames > 0 ? (double)Wins / TotalGames : 0;
    public int EloRating { get; set; } = 1000;
}

public class PlayerStats
{
    public string PlayerId { get; set; } = "";
    public string PlayerName { get; set; } = "";
    public DifficultyStats Easy { get; set; } = new();
    public DifficultyStats Medium { get; set; } = new();
    public DifficultyStats Hard { get; set; } = new();
    public int TotalWins => Easy.Wins + Medium.Wins + Hard.Wins;
    public int TotalLosses => Easy.Losses + Medium.Losses + Hard.Losses;
    public int TotalDraws => Easy.Draws + Medium.Draws + Hard.Draws;
    public int TotalGames => TotalWins + TotalLosses + TotalDraws;
    public double WinRate => TotalGames > 0 ? (double)TotalWins / TotalGames : 0;
}

public class StatItem
{
    public string Value { get; set; } = "";
    public string Label { get; set; } = "";
}

public class StatusInfo
{
    public string Icon { get; set; } = "";
    public string Text { get; set; } = "";
    public string ClassName { get; set; } = "";
}

public class WinResult
{
    public bool Won { get; set; }
    public List<(int Row, int Col)> Cells { get; set; } = new();
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

public class MarbleRaceHighScore
{
    public string PlayerInitials { get; set; } = "";
    public int BestScore { get; set; }
    public string Date { get; set; } = "";
    public double GameDuration { get; set; }
}
