// filepath: src/PoMiniGames.API/AI/JevInputEstimator.cs
using System.Text.Json;

namespace PoMiniGames.AI;

/// <summary>
/// Token-cost estimator for a Jev call. Used by the telemetry decorator to
/// compute USD spend for the diagnostics surface when the upstream does not
/// echo a token count back (Jev's response payload is typed primitives only —
/// no <c>usage</c> field).
///
/// <para>
/// <b>Why estimate, not measure?</b> OpenRouter returns a <c>usage</c> object
/// on chat completions but the <c>/v1/decisions</c> surface TypeSafe exposes
/// is documented without one. The estimate below uses <see cref="JsonSerializer"/>
/// to serialise the exact payload the client sends and divides by 4 — the
/// rough heuristic for English-language JSON. The error band on a 2K-token
/// state is well under 10%, which is fine for a diagnostics row.
/// </para>
/// </summary>
public static class JevInputEstimator
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// Estimate the input-token count for one Jev call. Approximates the wire
    /// payload: model + state + one question + (optional criteria/levels).
    /// </summary>
    public static long EstimateTokens(string instructions, object state, IReadOnlyDictionary<string, string>? extra = null)
    {
        // Roughly 4 characters per token for English + JSON punctuation. Empirically within
        // ~10% of the actual count for the small states we send. This is a diagnostic-only
        // number; the gate logic does not depend on it.
        long chars = 0;
        chars += instructions.Length;
        try
        {
            chars += JsonSerializer.Serialize(state, Json).Length;
        }
        catch (NotSupportedException)
        {
            // Anonymous state objects occasionally carry a property the default serializer
            // can't walk. Estimate at zero for the state rather than throwing — the row
            // is a diagnostic, not a gate signal.
        }
        if (extra is not null)
        {
            try { chars += JsonSerializer.Serialize(extra, Json).Length; }
            catch (NotSupportedException) { }
        }
        // Add ~120 chars for the model name, the wrapper, and the question envelope.
        chars += 120;
        return Math.Max(1, chars / 4);
    }
}
