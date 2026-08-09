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
    /// <summary>Current consecutive win streak (reset on loss/draw). Surfaced
    /// in the Profile alongside the Easy/Medium/Hard bucket streaks.</summary>
    public int WinStreak { get; set; }

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

/// <summary>A row read back from the PoMarbleRace board. Read-only — the server owns every field.</summary>
public sealed class MarbleRaceHighScore
{
    public string PlayerInitials { get; set; } = "";
    public string UserId { get; set; } = "";
    public bool IsGuest { get; set; }
    public int BestScore { get; set; }
    public DateTimeOffset AchievedAtUtc { get; set; }
}

/// <summary>
/// A PoMarbleRace submission. Carries the score and nothing else: the player's name, id and
/// timestamp are resolved server-side from the auth cookie, so there is no field here to forge
/// them in, and no unread field an attacker can vary to mint duplicate rows.
/// </summary>
public sealed record MarbleRaceHighScoreRequest(int BestScore);

public class PoBrawlHighScore
{
    public string PlayerInitials { get; set; } = "";
    public double KoTimeSeconds { get; set; }
    public string Character { get; set; } = "";
    public string Date { get; set; } = "";
}

// PoSports scores use PoMiniGames.Domain.Models.PoSportsHighScore directly — the client
// already references that assembly (via PoMiniGames.Application), so a hand-kept mirror
// only bought silent drift: a renamed server field still deserialized, just as null.

public class PoBrawlLadderEntry
{
    public string PlayerName { get; set; } = "";
    public int PresidentsBeaten { get; set; }
    public int Elo { get; set; }
    public string Date { get; set; } = "";
}

// Fighter Elo rows use PoMiniGames.Domain.Models.PoBrawlFighterRating directly, for the
// same reason PoSports does above.

/// <summary>
/// One finished CPU-vs-CPU demo match. Carries who fought and who won, and nothing else:
/// the ratings, the deltas, and the fighters' display names are all resolved server-side,
/// so there is no field here to forge a rating in. On a draw the winner/loser split is
/// arbitrary and <see cref="IsDraw"/> decides the scoring.
/// </summary>
public sealed record PoBrawlDemoResultRequest(string WinnerFighterId, string LoserFighterId, bool IsDraw);

/// <summary>
/// Queued PlayerStats PUT for the offline score-sync pipeline: a stats snapshot
/// that failed to reach the server is parked and replayed by ScoreSyncService.
/// </summary>
public class PendingPlayerStats
{
    public string GameKey { get; set; } = "";
    public string PlayerName { get; set; } = "";
    public PlayerStats Stats { get; set; } = new();
}
