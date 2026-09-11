using PoMiniGames.Domain.Primitives;

namespace PoMiniGames.Domain.Services;

/// <summary>Why a submitted score was judged implausible.</summary>
public enum ScoreVerdict
{
    /// <summary>Nothing about the submission contradicts a real run.</summary>
    Plausible,

    /// <summary>Outside the board's absolute sanity range. Checkable without a play session.</summary>
    OutOfRange,

    /// <summary>The claimed result needs more wall-clock time than the play session actually ran.</summary>
    Impossible,

    /// <summary>The session was too short for a real round of this game at all.</summary>
    TooFast,
}

/// <param name="Min">Lowest value the board will store.</param>
/// <param name="Max">Absolute sanity ceiling — not a bound on real play.</param>
/// <param name="LowerIsBetter">True for time boards, where the submitted value is seconds elapsed.</param>
/// <param name="MinPlaySeconds">Wall-clock floor for a genuine round.</param>
/// <param name="MaxPerSecond">For point boards only: the fastest a real run could accrue points.
/// Ignored when <paramref name="LowerIsBetter"/>, where the time-vs-session check below is
/// both tighter and exact.</param>
public readonly record struct ScoreBounds(
    double Min,
    double Max,
    bool LowerIsBetter,
    double MinPlaySeconds,
    double MaxPerSecond);

/// <summary>
/// Per-board plausibility arithmetic: what a submitted score may be, and what it may be
/// <i>given how long the player was actually in the game</i>.
/// </summary>
/// <remarks>
/// <para>
/// Two independent tiers, and the split matters because only one of them needs the client's
/// cooperation:
/// </para>
/// <list type="number">
///   <item><b>Absolute range</b> (<see cref="CheckValue"/>) — pure arithmetic on the posted
///   number. Always enforced, on every submission, whether or not a play session was presented.
///   This is the tier that keeps <c>int.MaxValue</c> off the board.</item>
///   <item><b>Rate</b> (<see cref="CheckAgainstSession"/>) — compares the claim against
///   server-measured elapsed time from a signed play session. This is the tier that catches a
///   plausible-looking number that no human could have produced in the time available.</item>
/// </list>
/// <para>
/// <b>Time boards get the exact check.</b> For a board where the score IS a duration (PoSports,
/// PoRacer, PoBrawl's KO time), a submission claiming 12.4 seconds of racing from a session
/// that has only existed for 6 seconds is definitionally forged — no tuning constant required.
/// Point boards get the softer <c>MaxPerSecond</c> ceiling, which does need a number, so each
/// one below is set an order of magnitude above observed play rather than near it: the goal is
/// to reject the obviously fabricated, never to argue with a good run.
/// </para>
/// <para>
/// Boards absent from the table are unranked or CPU-driven (PoBrawl's demo Elo, PoEcosystem,
/// SandPlayground) and return null from <see cref="For"/> — the caller then applies whatever
/// slice-local validation it already had and skips both tiers.
/// </para>
/// </remarks>
public static class ScoreRules
{
    /// <summary>
    /// Slack allowed between a claimed duration and the measured session, covering the round
    /// trip, clock skew between mint and submit, and the gap between the in-game timer starting
    /// and the page's own clock. Generous on purpose: a false reject costs a real player their
    /// personal best.
    /// </summary>
    public const double ClockToleranceSeconds = 3.0;

    private static readonly Dictionary<GameKey, ScoreBounds> Bounds = new()
    {
        // Point boards. Max mirrors the value objects that already guard these two
        // (MarbleRaceScore, PoVoxelStrikeScore) so there is one number, not two that drift.
        [GameKey.PoMarbleRace] = new ScoreBounds(
            Min: 0, Max: 1_000_000, LowerIsBetter: false, MinPlaySeconds: 5, MaxPerSecond: 20_000),

        [GameKey.PoVoxelStrike] = new ScoreBounds(
            Min: 0, Max: 10_000_000, LowerIsBetter: false, MinPlaySeconds: 5, MaxPerSecond: 50_000),

        // Time boards. Max mirrors each endpoint's existing inline range check; MinPlaySeconds
        // is the floor for the whole session, which for a meet or a race is longer than one leg.
        [GameKey.PoSports] = new ScoreBounds(
            Min: 0.5, Max: 600, LowerIsBetter: true, MinPlaySeconds: 5, MaxPerSecond: 0),

        [GameKey.PoRacer] = new ScoreBounds(
            Min: 1, Max: 3_600, LowerIsBetter: true, MinPlaySeconds: 5, MaxPerSecond: 0),

        // PoBrawl's board is fastest KO, so the score is again a duration. A KO cannot land
        // before the round starts, and the 600s ceiling matches the other time boards.
        [GameKey.PoBrawl] = new ScoreBounds(
            Min: 0.5, Max: 600, LowerIsBetter: true, MinPlaySeconds: 3, MaxPerSecond: 0),
    };

    /// <summary>The bounds for a board, or null when the board has no rules (unranked/CPU-driven).</summary>
    public static ScoreBounds? For(GameKey game) =>
        Bounds.TryGetValue(game, out var bounds) ? bounds : null;

    /// <summary>
    /// Tier one: absolute range. Safe to call on every submission — it needs nothing from the
    /// client beyond the number itself.
    /// </summary>
    public static ScoreVerdict CheckValue(GameKey game, double score)
    {
        if (For(game) is not { } bounds)
        {
            return ScoreVerdict.Plausible;
        }

        if (double.IsNaN(score) || double.IsInfinity(score))
        {
            return ScoreVerdict.OutOfRange;
        }

        return score < bounds.Min || score > bounds.Max
            ? ScoreVerdict.OutOfRange
            : ScoreVerdict.Plausible;
    }

    /// <summary>
    /// Tier two: rate. <paramref name="elapsed"/> must be the server's own measurement (mint
    /// timestamp to submit timestamp), never a client-reported duration — a forged duration
    /// makes every check here self-certifying.
    /// </summary>
    public static ScoreVerdict CheckAgainstSession(GameKey game, double score, TimeSpan elapsed)
    {
        var valueVerdict = CheckValue(game, score);
        if (valueVerdict != ScoreVerdict.Plausible)
        {
            return valueVerdict;
        }

        if (For(game) is not { } bounds)
        {
            return ScoreVerdict.Plausible;
        }

        var seconds = elapsed.TotalSeconds;
        if (seconds + ClockToleranceSeconds < bounds.MinPlaySeconds)
        {
            return ScoreVerdict.TooFast;
        }

        if (bounds.LowerIsBetter)
        {
            // The claimed duration cannot exceed the time the player has actually been playing.
            return score > seconds + ClockToleranceSeconds
                ? ScoreVerdict.Impossible
                : ScoreVerdict.Plausible;
        }

        var ceiling = (seconds + ClockToleranceSeconds) * bounds.MaxPerSecond;
        return score > ceiling ? ScoreVerdict.Impossible : ScoreVerdict.Plausible;
    }

    /// <summary>Human-readable cause, for the 400 body and the rejection log.</summary>
    public static string Describe(ScoreVerdict verdict) => verdict switch
    {
        ScoreVerdict.OutOfRange => "Score is outside the range this board accepts.",
        ScoreVerdict.Impossible => "Score is not achievable in the time this session was open.",
        ScoreVerdict.TooFast => "The session was too short to have produced a result.",
        _ => "Score accepted.",
    };
}
