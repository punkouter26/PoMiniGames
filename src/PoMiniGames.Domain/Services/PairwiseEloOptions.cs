namespace PoMiniGames.Domain.Services;

/// <summary>
/// Tuning for <see cref="PairwiseEloCalculator"/> — the head-to-head fighter ratings behind
/// the PoBrawl demo board.
/// </summary>
/// <remarks>
/// Deliberately its own type and its own configuration section rather than extra
/// <c>Fighter*</c> fields on <see cref="EloOptions"/>. The two rating systems must not merge
/// (see <see cref="PairwiseEloCalculator"/>), and sharing an options object made that
/// separation lexical — a naming convention — instead of structural: every
/// <see cref="EloCalculator"/> consumer carried knobs it must never read, and a third rating
/// system would have extended the prefix rather than getting a section of its own.
/// </remarks>
public class PairwiseEloOptions
{
    /// <summary>Configuration section this binds to.</summary>
    public const string SectionName = "PoMiniGames:PoBrawlFighterElo";

    /// <summary>
    /// Rating every PoBrawl fighter starts at before its first demo match. Default: 1000.
    /// </summary>
    /// <remarks>
    /// A flat seed for all fighters, deliberately — seeding from each president's ladder
    /// difficulty would bake the designer's intended difficulty curve into a board whose
    /// entire purpose is to measure what the roster actually does.
    /// </remarks>
    public int SeedElo { get; set; } = 1000;

    /// <summary>K-factor for head-to-head fighter ratings. Default: 24.</summary>
    /// <remarks>
    /// Lower than <see cref="EloOptions.K"/> (32) on purpose: an unattended kiosk plays these
    /// matches continuously over a closed 15-fighter pool, so the sample is large and the
    /// board wants stability more than responsiveness.
    /// </remarks>
    public int K { get; set; } = 24;

    /// <summary>
    /// Floor below which a fighter's rating cannot fall. Default: 100.
    /// </summary>
    /// <remarks>
    /// Real Elo is unbounded, but this board is left running unattended; without a floor the
    /// weakest fighter drifts to a negative rating that reads as a rendering bug. The floor
    /// takes precedence over the zero-sum property — see <see cref="PairwiseEloCalculator"/>.
    /// </remarks>
    public int FloorElo { get; set; } = 100;
}
