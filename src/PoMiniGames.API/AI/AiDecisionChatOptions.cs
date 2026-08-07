using System.Text.Json;
using Microsoft.Extensions.AI;
using OpenAI.Chat;

namespace PoMiniGames.AI;

/// <summary>
/// Builds the per-call <see cref="ChatOptions"/> for a short, machine-read decision — the shape
/// every real-time game loop in this solution needs from a model.
/// </summary>
/// <remarks>
/// <para>
/// This exists because "send no options at all" was, for a while, the documented position in
/// <c>AzureOpenAIInferenceService</c>, and it was wrong in a way that took the game down. The
/// deployment behind PoSurvive is a reasoning-family model (<c>gpt-5-nano</c> / <c>gpt-5.4-nano</c>),
/// and the two obvious knobs each fail on their own:
/// </para>
/// <list type="bullet">
///   <item><b>Temperature.</b> Anything other than the default is rejected outright
///   (<c>400 unsupported_value</c>), so it is never set here.</item>
///   <item><b>An output cap alone.</b> Reasoning tokens are spent before any visible text, so a
///   cap starves the answer instead of shortening it: HTTP 200 with a zero-length completion.</item>
///   <item><b>Neither.</b> Uncapped, the model reasons past every timeout — measured at over 45 s
///   per call, against a client that abandons the agent at 15 s. Every relayed call 503'd after
///   three 15-second SDK attempts.</item>
/// </list>
/// <para>
/// The combination is what works, and it has to travel together: <b>minimal reasoning effort</b>
/// plus a bounded output. Measured on the shared foundry account with both set —
/// <c>gpt-5-nano</c> answers in 6.8 s with <c>reasoning_tokens: 0</c>, <c>gpt-5.4-nano</c> in
/// 1.09 s. The reasoning cap has no first-class property in Microsoft.Extensions.AI, so it rides
/// on <see cref="ChatOptions.RawRepresentationFactory"/>; ME.AI uses that object as the base and
/// layers the strongly-typed options over it.
/// </para>
/// </remarks>
public static class AiDecisionChatOptions
{
    /// <summary>
    /// Reasoning effort sent on every decision call. <c>ChatReasoningEffortLevel</c> is an
    /// extensible enum whose named members stop at Low; "minimal" is a newer service value, so
    /// it is constructed from the wire string rather than a member that does not exist yet.
    /// </summary>
    /// <remarks>
    /// OPENAI001 marks the reasoning-effort surface as evaluation-only in OpenAI 2.10.0. Suppressed
    /// deliberately and narrowly: the wire field is what makes this game's deployment usable at all
    /// (verified 200/6.8 s with it, hard timeout without), and the escape hatch if the type is ever
    /// reshaped is the same one used here — a string.
    /// </remarks>
#pragma warning disable OPENAI001
    private static readonly ChatReasoningEffortLevel MinimalReasoning = new("minimal");
#pragma warning restore OPENAI001

    /// <summary>
    /// Options for a call whose reply must satisfy <paramref name="schema"/>.
    /// </summary>
    /// <param name="schema">JSON Schema the reply must match. Enum-constrained fields are what
    /// make the parsed action unforgeable rather than scraped out of prose.</param>
    /// <param name="schemaName">Schema name sent to the service (letters, digits, _ and - only).</param>
    /// <param name="maxOutputTokens">Hard output ceiling. Must be generous enough for the whole
    /// reply — see the remarks on why a tight cap alone is worse than none.</param>
    /// <param name="schemaDescription">Optional human description passed through to the service.</param>
    public static ChatOptions ForStructuredDecision(
        JsonElement schema,
        string schemaName,
        int maxOutputTokens,
        string? schemaDescription = null) => new()
        {
            MaxOutputTokens = maxOutputTokens,
            // Fully qualified: OpenAI.Chat has a same-named type, and `using OpenAI.Chat` is
            // needed here for ChatCompletionOptions below.
            ResponseFormat = Microsoft.Extensions.AI.ChatResponseFormat.ForJsonSchema(
                schema, schemaName, schemaDescription),
#pragma warning disable OPENAI001 // see MinimalReasoning
            RawRepresentationFactory = _ => new ChatCompletionOptions
            {
                ReasoningEffortLevel = MinimalReasoning,
            },
#pragma warning restore OPENAI001
        };

    /// <summary>
    /// The same bounded, machine-read shape as <see cref="ForStructuredDecision"/>, but built for
    /// the deployment that will actually serve it — so a task can be moved onto a cheaper model
    /// without the call starting to 400.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <see cref="ForStructuredDecision"/> hard-codes both wire fields, which is correct for
    /// PoSurvive (pinned to a gpt-5 nano deployment) and wrong for anything that might be pointed
    /// at <c>Phi-4-mini-instruct</c>: that deployment rejects <c>reasoning_effort</c> and does not
    /// implement <c>json_schema</c>. Each field is therefore attached only when
    /// <see cref="AiModelCapabilities"/> says the deployment takes it.
    /// </para>
    /// <para>
    /// When the schema cannot be sent the response format degrades to JSON-object mode. That is
    /// strictly weaker — the contract is then a request in the prompt rather than something the
    /// service enforces — so callers must keep a defensive parser. Every caller here does; the
    /// schema upgrades them from "hopefully valid" to "cannot be otherwise", it does not replace
    /// the parsing.
    /// </para>
    /// </remarks>
    /// <param name="deployment">Deployment the call will be routed to. Determines which wire
    /// fields are safe to send.</param>
    /// <param name="capabilityOverrides">Optional name → profile map from configuration; see
    /// <see cref="AIFoundryOptions.ModelCapabilityOverrides"/>.</param>
    public static ChatOptions ForStructuredJson(
        JsonElement schema,
        string schemaName,
        int maxOutputTokens,
        string deployment,
        string? schemaDescription = null,
        IReadOnlyDictionary<string, string>? capabilityOverrides = null)
    {
        var caps = AiModelCapabilities.For(deployment, capabilityOverrides);

        var options = new ChatOptions
        {
            MaxOutputTokens = maxOutputTokens,
            ResponseFormat = caps.SupportsJsonSchema
                ? Microsoft.Extensions.AI.ChatResponseFormat.ForJsonSchema(schema, schemaName, schemaDescription)
                : Microsoft.Extensions.AI.ChatResponseFormat.Json,
        };

        if (caps.SupportsReasoningEffort)
        {
#pragma warning disable OPENAI001 // see MinimalReasoning
            options.RawRepresentationFactory = _ => new ChatCompletionOptions
            {
                ReasoningEffortLevel = MinimalReasoning,
            };
#pragma warning restore OPENAI001
        }

        return options;
    }

    /// <summary>
    /// Plain bounded text, for the one output in this solution that is genuinely prose (PoJoker's
    /// punchline prediction and its two-sentence explanation). Still capability-aware: the output
    /// ceiling is only safe on a reasoning deployment when minimal effort travels with it.
    /// </summary>
    public static ChatOptions ForBoundedText(
        int maxOutputTokens,
        string deployment,
        IReadOnlyDictionary<string, string>? capabilityOverrides = null)
    {
        var caps = AiModelCapabilities.For(deployment, capabilityOverrides);
        var options = new ChatOptions { MaxOutputTokens = maxOutputTokens };

        if (caps.SupportsReasoningEffort)
        {
#pragma warning disable OPENAI001 // see MinimalReasoning
            options.RawRepresentationFactory = _ => new ChatCompletionOptions
            {
                ReasoningEffortLevel = MinimalReasoning,
            };
#pragma warning restore OPENAI001
        }

        return options;
    }
}
