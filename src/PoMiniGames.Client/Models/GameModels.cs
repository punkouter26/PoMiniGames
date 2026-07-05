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

/// <summary>
/// Single adaptive skill rating for a 1-player game (e.g. Connect Five vs CPU).
/// Replaces the fixed Easy/Medium/Hard buckets: the CPU is matched to the
/// player's current <see cref="Elo"/> each game, so a win raises the rating (and
/// the next CPU is tougher) while a loss lowers it (next CPU is easier). Stored
/// locally per player.
/// </summary>
public class AdaptiveRating
{
    public const int StartingElo = 1200;

    public string PlayerName { get; set; } = "";
    public int Elo { get; set; } = StartingElo;
    public int Peak { get; set; } = StartingElo;
    public int Wins { get; set; }
    public int Losses { get; set; }
    public int Draws { get; set; }

    public int TotalGames => Wins + Losses + Draws;
    public double WinRate => TotalGames > 0 ? (double)Wins / TotalGames : 0;
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

public class MarbleRaceHighScore
{
    public string PlayerInitials { get; set; } = "";
    public int BestScore { get; set; }
    public string Date { get; set; } = "";
    public double GameDuration { get; set; }
}

public class PoBrawlHighScore
{
    public string PlayerInitials { get; set; } = "";
    public double KoTimeSeconds { get; set; }
    public string Character { get; set; } = "";
    public string Date { get; set; } = "";
}
