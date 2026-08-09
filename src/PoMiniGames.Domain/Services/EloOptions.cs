namespace PoMiniGames.Domain.Services;

/// <summary>
/// Configuration options for ELO rating computation.
/// Bound from the "PoMiniGames:Elo" configuration section.
/// </summary>
public class EloOptions
{
    public const string SectionName = "PoMiniGames:Elo";

    /// <summary>AI virtual ELO rating for Easy difficulty. Default: 800.</summary>
    public int EasyAiElo { get; set; } = 800;

    /// <summary>AI virtual ELO rating for Medium difficulty. Default: 1200.</summary>
    public int MediumAiElo { get; set; } = 1200;

    /// <summary>AI virtual ELO rating for Hard difficulty. Default: 1600.</summary>
    public int HardAiElo { get; set; } = 1600;

    /// <summary>Baseline player reference ELO (fixed — not adjusted per player). Default: 1000.</summary>
    public int PlayerReferenceElo { get; set; } = 1000;

    /// <summary>K-factor for ELO adjustment. Default: 32.</summary>
    public int K { get; set; } = 32;

    // ── Head-to-head fighter ratings (PoBrawl demo board) ─────────────────
    // Consumed by PairwiseEloCalculator, not by EloCalculator. Separate knobs because the
    // two systems answer different questions and must be tunable independently.

    /// <summary>
    /// Rating every PoBrawl fighter starts at before its first demo match. Default: 1000.
    /// </summary>
    /// <remarks>
    /// A flat seed for all fighters, deliberately — seeding from each president's ladder
    /// difficulty would bake the designer's intended difficulty curve into a board whose
    /// entire purpose is to measure what the roster actually does.
    /// </remarks>
    public int FighterSeedElo { get; set; } = 1000;

    /// <summary>K-factor for head-to-head fighter ratings. Default: 24.</summary>
    /// <remarks>
    /// Lower than <see cref="K"/> (32) on purpose: an unattended kiosk plays these matches
    /// continuously over a closed 15-fighter pool, so the sample is large and the board wants
    /// stability more than responsiveness.
    /// </remarks>
    public int FighterK { get; set; } = 24;

    /// <summary>
    /// Floor below which a fighter's rating cannot fall. Default: 100.
    /// </summary>
    /// <remarks>
    /// Real Elo is unbounded, but this board is left running unattended; without a floor the
    /// weakest fighter drifts to a negative rating that reads as a rendering bug. The floor
    /// takes precedence over the zero-sum property — see <see cref="PairwiseEloCalculator"/>.
    /// </remarks>
    public int FighterFloorElo { get; set; } = 100;
}
