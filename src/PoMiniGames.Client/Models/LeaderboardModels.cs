namespace PoMiniGamesClient.Models;

/// <summary>One ranked row in a normalized leaderboard. Mirrors the server's LeaderboardEntryDto.</summary>
public sealed class LeaderboardEntryDto
{
    public int Rank { get; set; }
    public string Name { get; set; } = "";
    public double Value { get; set; }
    public string DisplayValue { get; set; } = "";

    /// <summary>
    /// Long-form text for a row whose <see cref="Name"/> was clipped to fit the column,
    /// rendered as the row's hover title. Only PoJoker sends it (a row there is a joke);
    /// null on every other board, and a null title attribute is omitted entirely.
    /// </summary>
    public string? Detail { get; set; }
}

/// <summary>A single game's normalized leaderboard. Mirrors the server's GameLeaderboardDto.</summary>
public sealed class GameLeaderboardDto
{
    public string GameKey { get; set; } = "";
    public string Title { get; set; } = "";
    public string Unit { get; set; } = "";
    public bool HigherIsBetter { get; set; }
    public List<LeaderboardEntryDto> Entries { get; set; } = [];
}
