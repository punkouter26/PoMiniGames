namespace PoMiniGames.Domain.Models;

/// <summary>
/// A single PoCabinet high-score entry — best lap on a track. TrackId
/// partitions the leaderboard; the same player can hold one row per track
/// (so Capitol best-lap and Mar-a-Lago best-lap never compete).
/// </summary>
public sealed class PoCabinetHighScore
{
    public string PlayerName { get; set; } = string.Empty;
    /// <summary>Server-populated from the auth cookie (sub/oid). Empty for guests.</summary>
    public string UserId { get; set; } = string.Empty;
    public string TrackId { get; set; } = "capitol";
    /// <summary>Best completed lap in seconds.</summary>
    public double BestLapSeconds { get; set; }
    /// <summary>Final position in the race that produced the best lap (1..9).</summary>
    public int FinalPosition { get; set; }
    public bool IsGuest { get; set; }
    public string Date { get; set; } = string.Empty;
    /// <summary>Lobby / race code; diagnostic-only.</summary>
    public string GameCode { get; set; } = string.Empty;
}