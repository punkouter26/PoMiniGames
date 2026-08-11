namespace PoMiniGames.Application.DTOs;

/// <summary>
/// One ranked row in a normalized leaderboard. <see cref="Value"/> is the raw comparable number;
/// <see cref="DisplayValue"/> is the already-formatted string for the UI (e.g. "73%", "1,240", "8.4s"),
/// so the client never has to know whether a game is scored by win-rate, points, or survival time.
/// </summary>
/// <param name="Detail">
/// Optional long-form text for a row whose <paramref name="Name"/> has to be truncated to fit —
/// rendered as the row's hover title. Only PoJoker uses it today (a board row is a joke, and the
/// setup alone overflows the column), so it is nullable and every other board leaves it null
/// rather than every board growing a field for one game's benefit.
/// </param>
public sealed record LeaderboardEntryDto(
    int Rank, string Name, double Value, string DisplayValue, string? Detail = null);

/// <summary>
/// A single game's leaderboard in a shape that is identical across every game. Collapses the
/// previously divergent per-game boards (win-rate stats, snake points, marble points, drop-square
/// survival) behind one contract so the client renders them with one component.
/// </summary>
public sealed record GameLeaderboardDto(
    string GameKey,
    string Title,
    string Unit,
    bool HigherIsBetter,
    IReadOnlyList<LeaderboardEntryDto> Entries);
