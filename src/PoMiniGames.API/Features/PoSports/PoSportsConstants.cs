namespace PoMiniGames.Features.PoSports;

/// <summary>
/// The PoSports stride-model constants — the single numeric contract between the
/// server-authoritative sim (<see cref="PoSportsSim"/>) and the client engine
/// (<c>wwwroot/js/posports/physics.js</c>). The JS module declares the same values;
/// <c>PoSportsConstantsSyncTests</c> parses that file and fails the build on any drift,
/// so a change here must be mirrored there in the same commit.
/// </summary>
public static class PoSportsConstants
{
    /// <summary>Speed impulse per completed key sequence (m/s).</summary>
    public const double Impulse = 3.8;

    /// <summary>Fraction of speed retained per second: v *= Decay^dt.</summary>
    public const double Decay = 0.45;

    /// <summary>Speed cap (m/s).</summary>
    public const double MaxSpeed = 19;

    /// <summary>Airborne window after a jump (seconds).</summary>
    public const double JumpDuration = 0.55;

    /// <summary>Impulse multiplier while airborne — typing mid-air is less effective.</summary>
    public const double JumpDrag = 0.85;

    /// <summary>Speed multiplier applied when a hurdle is hit while grounded.</summary>
    public const double StumbleFactor = 0.3;

    /// <summary>Seconds added to the leg time per stumble.</summary>
    public const double StumblePenalty = 1.5;

    /// <summary>Hold applied when a key is pressed before the gun (seconds).</summary>
    public const double FalseStartHold = 0.5;

    /// <summary>Sprint leg length (meters).</summary>
    public const double SprintLength = 100;

    /// <summary>Hurdles leg length (meters).</summary>
    public const double HurdlesLength = 110;

    /// <summary>Server-owned interstitial between the legs (seconds).</summary>
    public const double InterstitialSeconds = 8;

    /// <summary>Fixed simulation step (seconds) — identical on both sims by contract.</summary>
    public const double Tick = 1.0 / 60.0;

    /// <summary>Duration the stumble (hit-react) animation locks the lane, seconds.
    /// Mirrors <c>STUMBLE_ANIM_SECONDS</c> in physics.js.</summary>
    public const double StumbleAnimSeconds = 0.7;

    // Server AI cadence: keys per second and wrong-key probability for the medium-difficulty
    // typists that fill online lanes. These mirror DIFFICULTIES.medium in ai.js and are pinned
    // by PoSportsConstantsSyncTests — they used to live as private fields in PoSportsSim with
    // only a comment claiming the mirror, so a difficulty rebalance desynced online CPU rivals
    // from local ones with no build break.

    /// <summary>Target key cadence for server AI lanes (keys/second).</summary>
    public const double AiKeysPerSecond = 10.0;

    /// <summary>Probability that a server AI lane presses a wrong key.</summary>
    public const double AiErrorRate = 0.008;

    /// <summary>How far before a hurdle a server AI lane decides to jump (meters).</summary>
    public const double AiJumpLookahead = 1.8;

    /// <summary>Hurdle positions along the hurdles leg (meters from the start line).</summary>
    public static readonly IReadOnlyList<double> HurdlePositions =
        [20, 30, 40, 50, 60, 70, 80, 90];

    /// <summary>
    /// The playable character keys. Sourced from <see cref="PoMiniGames.Shared.Games.PoSportsRoster"/>
    /// so the server, the lobby page, and the race page cannot disagree about who exists.
    /// </summary>
    public static IReadOnlyList<string> Characters => PoMiniGames.Shared.Games.PoSportsRoster.Keys;
}
