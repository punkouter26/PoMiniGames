namespace PoMiniGames.Shared.Games;

/// <summary>
/// Display metadata for the three themed PoCabinet tracks.
/// <see cref="PoMiniGames.Features.PoCabinet.PoCabinetTrackRegistry"/> consumes this
/// catalog to populate <c>PoCabinetTrackData.DisplayName</c> / <c>Description</c>.
/// Track ids are lower-case, kebab-friendly strings safe for URL paths.
/// </summary>
public sealed record PoCabinetTrackInfo(string Id, string Name, string Description);

public static class PoCabinetCatalog
{
    /// <summary>Total race laps. Matches PoRacer's per-race length so leaderboard comparisons are apples-to-apples.</summary>
    public const int TotalLaps = 3;

    /// <summary>Maximum car count on a track (player + AI officials).</summary>
    public const int CarCount = 8;

    /// <summary>Default track when none is specified (matches the championship opening leg).</summary>
    public const string DefaultTrackId = "capitol";

    public static IReadOnlyList<PoCabinetTrackInfo> Tracks { get; } = Array.AsReadOnly(new[]
    {
        new PoCabinetTrackInfo(
            "capitol",
            "Capitol Speedway",
            "Asphalt oval framed by marble columns and gold trim. Government-building backdrop."),
        new PoCabinetTrackInfo(
            "maralago",
            "Mar-a-Lago Grand Prix",
            "Palm-lined beachside course with golf-course greens and ocean mist."),
        new PoCabinetTrackInfo(
            "pressbriefing",
            "Press Briefing 500",
            "Podium-shaped stadium with press-box grandstands and klieg lights."),
    });

    public static PoCabinetTrackInfo GetTrack(string? id) =>
        Tracks.FirstOrDefault(t => string.Equals(t.Id, id?.Trim(), StringComparison.OrdinalIgnoreCase)) ?? Tracks[0];

    public static bool IsKnownTrack(string? id) =>
        Tracks.Any(t => string.Equals(t.Id, id?.Trim(), StringComparison.OrdinalIgnoreCase));
}
