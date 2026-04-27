namespace PoMiniGames.Features.PoRunner;

/// <summary>
/// Configuration options for game timing, read from the "PoRunner" section in appsettings.
/// Override in test environments to speed up countdown and grace-period delays.
/// </summary>
public class GameOptions
{
    public const string SectionName = "PoRunner";

    /// <summary>Duration of the pre-race countdown in milliseconds. Default: 3000 ms.</summary>
    public int CountdownDurationMs { get; set; } = 3000;

    /// <summary>Grace window before a disconnected player is fully ejected from their room. Default: 1000 ms.</summary>
    public int GracePeriodMs { get; set; } = 1000;

    /// <summary>Maximum race duration in milliseconds. Default: 20000 ms.</summary>
    public int MaxRaceDurationMs { get; set; } = 20_000;
}