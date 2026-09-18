// filepath: src/PoMiniGames.API/AI/JevGate.cs
namespace PoMiniGames.AI;

/// <summary>
/// Threshold-checking helper shared by every gate caller (PoJoker, PoEcosystem).
/// Centralises the "should I spend a chat-model call?" decision so a future game
/// gets the same calibrated answer with a one-liner.
///
/// <para>
/// <b>Why a helper and not per-caller logic?</b> The threshold maths is the same
/// shape for every noul gate: <i>Jev says skip with at least N confidence</i>.
/// Putting it in one place means a change to the gate calibration (say, raising
/// the skip threshold for all gates after a spending incident) is a one-line
/// edit here, not a sweep across every call site. It also makes the rule
/// unit-testable without spinning up the chat pipeline.
/// </para>
/// </summary>
public static class JevGate
{
    /// <summary>
    /// True when the gate should skip the expensive call. Three conditions must
    /// ALL hold:
    /// <list type="number">
    ///   <item>Jev was actually consulted (not <see cref="JevDecision{T}.Bypass"/>).</item>
    ///   <item>The probability is below the configured threshold.</item>
    ///   <item>Jev's confidence in that probability is high enough that we trust it.</item>
    /// </list>
    /// Any single failure means "fall through" — i.e. behave as if the gate did not exist.
    /// </summary>
    /// <param name="decision">Jev's verdict. Bypass always falls through.</param>
    /// <param name="threshold">Probability above which the expensive call is justified. Typical range: 0.55–0.65.</param>
    /// <param name="minConfidence">Jev's confidence required to trust the verdict. Typical: 0.70.</param>
    public static bool ShouldSkip(JevDecision<double> decision, double threshold, double minConfidence = 0.70)
        => !decision.FailingThrough
            && decision.Confidence >= minConfidence
            && decision.Value < threshold;
}
