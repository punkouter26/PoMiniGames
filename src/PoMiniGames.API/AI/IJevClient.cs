// filepath: src/PoMiniGames.API/AI/IJevClient.cs
using System.Text.Json.Serialization;

namespace PoMiniGames.AI;

/// <summary>
/// Typed decision contract for TypeSafe's Jev System One model — the pre-call gate
/// that decides whether an expensive chat-model call is worth making.
/// <para>
/// <b>Why this exists.</b> The chat-client decorator chain
/// (<c>BudgetedChatClient → ResilientChatClient → InstrumentedChatClient</c>) targets
/// <c>OpenAI.Chat.ChatClient</c> and <c>Microsoft.Extensions.AI</c>. Jev is a different
/// surface (POST <c>/v1/decisions</c> returning typed primitives, not streamed tokens), so
/// it does not fit that pipeline — it is its own boundary, owned by a thin HTTP client
/// keyed by <c>PoMiniGames:Jev</c> and registered in <c>Program.cs</c>.
///
/// <b>Caller pattern.</b> Every caller MUST check <see cref="JevDecision{TValue}.FailingThrough"/>
/// before acting on the answer. Jev down = call the chat model anyway, exactly as today.
/// That keeps every existing endpoint working when the Jev key is missing, the budget
/// has run out, or the upstream is rate-limited.
///
/// <b>Test seam.</b> <see cref="tests.Shared.TestBudgetGuard"/> is the single source of
/// truth for AI mocking in this codebase; per-fixture <c>IJevClient</c> overrides are
/// acceptable here (the four fixtures keep their own stubs for now) but must use
/// <see cref="JevTestOverrides"/> so they cannot drift — adding a new AI boundary means
/// exactly one edit there.
/// </para>
/// </summary>
public interface IJevClient
{
    /// <summary>
    /// Evaluate a single boolean / probability question. State is JSON-serialized
    /// (Jev's contract is plain JSON, not typed C#).
    /// </summary>
    /// <param name="instructions">Plain-English statement of what is being decided.</param>
    /// <param name="state">JSON-serializable context Jev evaluates the question against.</param>
    /// <param name="ct">Cancellation; Jev's 1-2 s budget lives in the resilience pipeline.</param>
    /// <returns>
    /// Calibrated probability in <c>[0, 1]</c> on success. Returns
    /// <see cref="JevDecision{TValue}.FailingThrough"/> = <c>true</c> on any failure so
    /// the caller falls back to the original behavior.
    /// </returns>
    Task<JevDecision<double>> EvaluateNoulAsync(string instructions, object state, CancellationToken ct = default);

    /// <summary>
    /// Evaluate a categorical choice over a fixed set of options. Jev cannot
    /// invent options outside the declared <paramref name="criteria"/>; an empty
    /// criteria is rejected before the call.
    /// </summary>
    Task<JevDecision<string>> EvaluateChoiceAsync(string instructions, IReadOnlyDictionary<string, string> criteria, object state, CancellationToken ct = default);

    /// <summary>
    /// Evaluate an ordered rubric (0..levels.Count - 1). <paramref name="levels"/>
    /// keys are stringified integers (<c>"0"</c>, <c>"1"</c>, …) so the JSON
    /// matches Jev's wire format directly.
    /// </summary>
    Task<JevDecision<double>> EvaluateScoreAsync(string instructions, IReadOnlyDictionary<string, string> levels, object state, CancellationToken ct = default);
}

/// <summary>
/// One Jev decision. <see cref="Confidence"/> is the calibrated probability the
/// answer is correct; <see cref="FailingThrough"/> is the bypass signal callers MUST
/// check before branching on <see cref="Value"/>.
/// </summary>
/// <remarks>
/// Both <c>Confidence</c> and <c>FailingThrough</c> exist on every decision so the
/// call-site cannot forget the failure path. Setting <c>FailingThrough = true</c>
/// zeroes <c>Confidence</c> so a stray <c>if (Confidence &gt; 0.7)</c> guard also
/// degrades safely.
/// </remarks>
public readonly record struct JevDecision<TValue>(TValue Value, double Confidence, bool FailingThrough)
{
    /// <summary>
    /// Build a passing-through decision when Jev could not be consulted. Callers
    /// see <c>FailingThrough = true</c> and ignore <see cref="Value"/>.
    /// </summary>
    public static JevDecision<TValue> Bypass() => new(default!, 0d, FailingThrough: true);
}

/// <summary>
/// Wire-format DTOs for the <c>/v1/decisions</c> response. Mirrors the schema on
/// <c>https://docs.typesafe.ai</c>; the JSON property names are pinned to Jev's
/// contract and must not be camelCased away.
/// </summary>
internal sealed class JevAnswer<TValue>
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = string.Empty;

    [JsonPropertyName("noul")]
    public double? Noul { get; set; }

    [JsonPropertyName("choice")]
    public string? Choice { get; set; }

    [JsonPropertyName("score")]
    public double? Score { get; set; }

    [JsonPropertyName("probabilities")]
    public Dictionary<string, double>? Probabilities { get; set; }

    [JsonPropertyName("confidence")]
    public double Confidence { get; set; }
}

internal sealed class JevResponse<TValue>
{
    [JsonPropertyName("answers")]
    public Dictionary<string, JevAnswer<TValue>> Answers { get; set; } = new();
}
