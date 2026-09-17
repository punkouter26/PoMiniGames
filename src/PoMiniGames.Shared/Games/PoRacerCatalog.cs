namespace PoMiniGames.Shared.Games;

public sealed record PoRacerTrackInfo(string Id, string Name, string Description);

public static class PoRacerCatalog
{
    public const int TotalLaps = 3;
    public const int CarCount = 8;
    public const string DefaultTrackId = "circuit";
    public static IReadOnlyList<PoRacerTrackInfo> Tracks { get; } = Array.AsReadOnly(new[]
    {
        new PoRacerTrackInfo("circuit", "Grand Prix Circuit", "Classic asphalt with sweeping bends and high grip."),
        new PoRacerTrackInfo("neonskyline", "Neon Skyline", "Neon city streets with fast chicanes."),
        new PoRacerTrackInfo("desertdustway", "Desert Dustway", "Wide hairpins and loose sand that rewards careful drifting.")
    });

    public static PoRacerTrackInfo GetTrack(string? id) =>
        Tracks.FirstOrDefault(t => string.Equals(t.Id, id?.Trim(), StringComparison.OrdinalIgnoreCase)) ?? Tracks[0];
}
