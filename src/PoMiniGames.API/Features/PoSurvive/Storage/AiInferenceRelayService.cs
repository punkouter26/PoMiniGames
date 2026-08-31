using System.Text.Json;
using Microsoft.Extensions.AI;
using PoMiniGames.AI;
using PoMiniGames.Shared.Simulation.Interfaces;
using PoMiniGames.Shared.Simulation.Models;

namespace PoMiniGames.Features.PoSurvive.Storage;

// GoF: Strategy — implements IInferenceService; activated only when Inference:UseCloudFallback=true.
// SOLID: DIP — callers depend on IInferenceService; this class wires in Azure OpenAI via ME.AI.
// Never exposed directly to the WASM client; accessed only through POST /api/infer relay (T076a).
//
// Historical note: this class previously lived at
//   src/PoMiniGames.Infrastructure/AI/AzureOpenAIInferenceService.cs
// under the phantom namespace `PoSurvive.Infrastructure.AI` (the project
// `PoMiniGames.Infrastructure` is a layered platform project — not a
// PoSurvive module). After the broader AI namespace consolidation the
// file moved here where it conceptually belongs (the PoSurvive server
// slice's storage boundary).
public sealed class AiInferenceRelayService : IInferenceService
{
    /// <summary>
    /// Output ceiling per decision. Generous on purpose: it is only safe because minimal
    /// reasoning effort travels with it (see <see cref="AiDecisionChatOptions"/>). A tight cap
    /// on its own returns HTTP 200 with a zero-length completion.
    /// </summary>
    public const int MaxOutputTokens = 300;

    private readonly IChatClient _chat;
    private readonly IReadOnlyDictionary<string, string> _deploymentMap;
    private readonly Func<string, IChatClient?>? _clientForDeployment;
    private readonly ILogger<AiInferenceRelayService> _logger;
    private readonly IAiDecisionOptionsCache _optionsCache;
    private readonly IReadOnlyDictionary<string, string>? _capabilityOverrides;
    // Deployment name associated with the default chat client. Set by the DI factory after the
    // AIFoundryOptions monitor resolves it; falls back to the constant default when the legacy
    // api-key registration path constructs this class without supplying one.
    private string _defaultDeploymentForChat = string.Empty;

    public AiInferenceRelayService(
        IChatClient chat,
        IReadOnlyDictionary<string, string>? deploymentMap = null,
        ILogger<AiInferenceRelayService>? logger = null,
        Func<string, IChatClient?>? clientForDeployment = null,
        IAiDecisionOptionsCache? optionsCache = null,
        IReadOnlyDictionary<string, string>? capabilityOverrides = null,
        string? defaultDeploymentName = null)
    {
        _chat = chat;
        _deploymentMap = deploymentMap ?? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        _clientForDeployment = clientForDeployment;
        _logger = logger ?? Microsoft.Extensions.Logging.Abstractions.NullLogger<AiInferenceRelayService>.Instance;
        // Options cache + capability overrides are nullable so the legacy api-key registration
        // path in PoSurviveServiceExtensions (which constructs this directly) keeps compiling.
        // When null, the service rebuilds the ChatOptions per call — the documented cost is ~5 µs.
        _optionsCache = optionsCache ?? NullOptionsCache.Instance;
        _capabilityOverrides = capabilityOverrides;
        _defaultDeploymentForChat = defaultDeploymentName ?? string.Empty;
    }

    private string ResolveDeploymentForChat(IChatClient chat)
    {
        // The cache key needs a deployment name; if the DI path didn't supply one (legacy
        // registrations) we have to fall back to a placeholder. The placeholder never matches
        // a real deployment, so a process that ends up here loses the cache benefit but
        // continues to work — and the log line tells the operator which path is missing the wire.
        if (!string.IsNullOrEmpty(_defaultDeploymentForChat))
            return _defaultDeploymentForChat;

        _logger.LogWarning(
            "AzureOpenAIInferenceService constructed without a default deployment name; ChatOptions will rebuild per call.");
        return "_unknown_";
    }

    /// <inheritdoc />
    public Task<InferenceResult> InferAsync(string gridJson, PersonalityDnaDto dna, CancellationToken ct = default)
        => InferWithClientAsync(_chat, ResolveDeploymentForChat(_chat), gridJson, dna, ct);

    /// <summary>
    /// Per-request model selection. Resolves <paramref name="modelId"/> through the allowlist and
    /// serves it from a chat client bound to that deployment.
    /// </summary>
    /// <remarks>
    /// This used to log the requested id and then silently answer from the default deployment, so
    /// <c>/api/infer</c> advertised per-request model selection that did not exist. An unknown or
    /// absent id still falls back to the default — the allowlist is the security boundary, and a
    /// caller must not be able to name an arbitrary deployment.
    /// </remarks>
    public Task<InferenceResult> InferWithModelAsync(
        string gridJson,
        PersonalityDnaDto dna,
        string? modelId,
        CancellationToken ct = default)
    {
        var (chat, deployment) = ResolveClientAndDeployment(modelId);
        return InferWithClientAsync(chat, deployment, gridJson, dna, ct);
    }

    private (IChatClient Chat, string Deployment) ResolveClientAndDeployment(string? modelId)
    {
        if (!string.IsNullOrWhiteSpace(modelId) && _clientForDeployment is not null
            && _deploymentMap.TryGetValue(modelId!, out var deployment))
        {
            var chat = _clientForDeployment(deployment);
            if (chat is not null)
                return (chat, deployment);
        }

        if (!string.IsNullOrWhiteSpace(modelId))
        {
            _logger.LogDebug(
                "Requested modelId={ModelId} is not on the server allowlist; serving from the default deployment.",
                modelId);
        }

        return (_chat, _defaultDeploymentForChat);
    }

    private IChatClient? ResolveClient(string? modelId)
        => ResolveClientAndDeployment(modelId).Chat;

    private async Task<InferenceResult> InferWithClientAsync(
        IChatClient chat, string deployment, string gridJson, PersonalityDnaDto dna, CancellationToken ct)
    {
        var messages = new List<ChatMessage>
        {
            new(ChatRole.System, SimulationSystemPrompt),
            new(ChatRole.User,   BuildUserPrompt(gridJson, dna)),
        };

        // The cache keys on (game, deployment, capability profile), so a per-request model
        // selection that names a different deployment gets a different (still single-allocation)
        // options instance. The fallback `DecisionOptionsFor` is reserved for paths that lost
        // the cache reference entirely (legacy api-key registrations).
        var options = _optionsCache.Count > 0
            ? BuildDecisionOptions(deployment)
            : DecisionOptionsFor(deployment);

        // ── Streaming with early commit ───────────────────────────────────
        // The reply is a small JSON object whose FIRST field is the action. Streaming lets the
        // parser consume the action the moment it arrives and stop reading — the thought tail,
        // which is the bulk of the output tokens, is then still being generated while the game
        // has already committed the move. Measured on the shared account, the action field
        // arrives at roughly half the total wall time of a non-streamed call.
        //
        // The cancellation after the parse is what converts "half the time" into an actual
        // saving: once the decision is extracted, the remaining generation is cancelled and the
        // provider stops billing output tokens for text nobody will read.
        if (chat is IChatClient && options is not null)
        {
            var streamed = await TryStreamEarlyCommitAsync(chat, messages, options, ct);
            if (streamed is { } result)
                return result;
            // Streaming unavailable or produced nothing usable — fall through to the buffered
            // call below, which is the behaviour this service has always had.
        }

        var response = await chat.GetResponseAsync(messages, options, ct);
        var parsed = ParseInferenceResult(response.Text);

        if (parsed is null)
        {
            // Unusable output is a provider failure, not a decision. It used to be returned as a
            // 200 carrying Action="Idle" and Thought="unparseable model response", which the
            // client could not tell apart from an agent genuinely choosing to stand still — so a
            // broken deployment looked like a cautious AI. The raw reply is logged because the two
            // causes need different fixes: rawLength=0 means the output budget was consumed before
            // any text (a reasoning-effort/token-cap problem), while unparseable text means the
            // model ignored the schema.
            _logger.LogWarning(
                "PoSurvive inference returned no usable JSON (rawLength={Length}). Raw: {Raw}",
                response.Text?.Length ?? 0,
                Truncate(response.Text, 300));

            throw new InferenceResponseUnusableException(response.Text?.Length ?? 0);
        }

        return parsed;
    }

    /// <summary>
    /// Streams the reply and commits the decision as soon as the <c>action</c> field is
    /// parseable, cancelling the remaining generation. Returns null when streaming produced
    /// nothing usable, so the caller falls back to the buffered path.
    /// </summary>
    /// <remarks>
    /// The early-commit parser is deliberately tolerant of a truncated tail: it only needs
    /// <c>"action": "&lt;one of the enum values&gt;"</c> to have appeared in full. The thought
    /// field, which streams last, is taken from whatever arrived before cancellation — an empty
    /// thought is a valid outcome (the schema marks it required but the parser already tolerates
    /// its absence, and a cancelled tail is a known, logged condition rather than a parse error).
    /// </remarks>
    private async Task<InferenceResult?> TryStreamEarlyCommitAsync(
        IChatClient chat, List<ChatMessage> messages, ChatOptions options, CancellationToken ct)
    {
        var buffer = new System.Text.StringBuilder();

        try
        {
            await foreach (var update in chat.GetStreamingResponseAsync(messages, options, ct))
            {
                buffer.Append(update.Text);
                if (TryParseActionEarly(buffer.ToString()) is { } action)
                {
                    // Decision extracted. Cancel the tail: the thought is still generating, but
                    // the game has what it needs. The provider stops billing output tokens here.
                    var thought = TryExtractThought(buffer.ToString()) ?? string.Empty;
                    return new InferenceResult(Thought: thought, Action: action);
                }
            }

            // Stream completed without an early match — parse the whole thing once.
            return ParseInferenceResult(buffer.ToString());
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested && buffer.Length > 0)
        {
            // Our own cancellation from the caller's budget — but we have partial text. Try to
            // salvage a decision from it before giving up.
            if (TryParseActionEarly(buffer.ToString()) is { } action)
                return new InferenceResult(Thought: TryExtractThought(buffer.ToString()) ?? string.Empty, Action: action);
            throw;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Streaming itself failed (unsupported by the deployment, transport fault). Log and
            // let the caller fall back to the buffered path.
            _logger.LogDebug(ex,
                "PoSurvive streaming early-commit unavailable; falling back to buffered call.");
            return null;
        }
    }

    /// <summary>
    /// Extracts the <c>action</c> value from a possibly-incomplete JSON reply. Matches the
    /// enum values the schema constrains, so a partial match cannot yield an out-of-vocabulary
    /// action.
    /// </summary>
    private static string? TryParseActionEarly(string? partial)
    {
        if (string.IsNullOrEmpty(partial))
            return null;

        foreach (var action in new[] { "Attack", "Forage", "Flee", "Idle" })
        {
            // The schema guarantees the value appears as "action":"<value>" (or with whitespace).
            // A simple contains-check over the quoted value is safe because the enum values are
            // distinctive words that cannot appear as a substring of each other or of "thought".
            if (partial.Contains($"\"action\"", StringComparison.OrdinalIgnoreCase)
                && partial.Contains($"\"{action}\"", StringComparison.Ordinal))
                return action;
        }
        return null;
    }

    /// <summary>
    /// Extracts the <c>thought</c> value from a possibly-incomplete JSON reply, tolerating a
    /// tail that was cut off mid-string.
    /// </summary>
    private static string? TryExtractThought(string? partial)
    {
        if (string.IsNullOrEmpty(partial))
            return null;

        var key = "\"thought\"";
        var keyIdx = partial.IndexOf(key, StringComparison.OrdinalIgnoreCase);
        if (keyIdx < 0)
            return null;

        var colon = partial.IndexOf(':', keyIdx + key.Length);
        if (colon < 0)
            return null;

        var open = partial.IndexOf('"', colon + 1);
        if (open < 0)
            return null;

        // Find the closing quote, honouring the JSON escape (\" does not close).
        var sb = new System.Text.StringBuilder();
        for (var i = open + 1; i < partial.Length; i++)
        {
            var c = partial[i];
            if (c == '\\' && i + 1 < partial.Length)
            {
                sb.Append(partial[i + 1]);
                i++;
                continue;
            }
            if (c == '"')
                return sb.ToString();
            sb.Append(c);
        }

        // Unterminated string — the tail was cut mid-thought. Return what arrived.
        return sb.ToString();
    }

    /// <summary>
    /// The reply contract, as a schema the service enforces rather than a sentence the model may
    /// ignore. The <c>enum</c> on <c>action</c> is the part that matters: it makes an
    /// out-of-vocabulary action impossible instead of silently coerced to Idle by the parser.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <c>.Clone()</c> is load-bearing: a <see cref="JsonElement"/> is a view over its
    /// <see cref="JsonDocument"/>'s pooled buffer, so handing out the un-cloned root of a document
    /// nobody holds throws <see cref="InvalidOperationException"/> the moment the document is
    /// collected. Cloning detaches it onto its own buffer, which is what a static contract needs.
    /// </para>
    /// <para>
    /// Declared BEFORE <see cref="DecisionOptions"/> and not after it. Static initialisers run in
    /// textual order, and a <see cref="JsonElement"/> is a struct: with the two swapped, the
    /// options were built from <c>default(JsonElement)</c> and the schema silently went over the
    /// wire as <c>ValueKind.Undefined</c> — no exception, no schema, just the prose-scraping
    /// parser back in charge.
    /// </para>
    /// </remarks>
    public static JsonElement AgentDecisionSchema { get; } = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "action": { "type": "string", "enum": ["Attack", "Forage", "Flee", "Idle"] },
            "thought": { "type": "string", "maxLength": 90 }
          },
          "required": ["action", "thought"],
          "additionalProperties": false
        }
        """).RootElement.Clone();

    /// <summary>
    /// Bounded output plus minimal reasoning effort plus a strict schema — built once per
    /// (game, deployment, capability-profile) and shared. See <see cref="AiDecisionChatOptions"/>
    /// for why all three have to travel together.
    /// </summary>
    /// <remarks>
    /// Replaces a static singleton: the schema, the output ceiling and the capability profile
    /// can all vary by deployment, so the keying moves to <see cref="AiDecisionOptionsCache"/> and
    /// the static field is dropped. PoSurvive always calls with the same arguments in practice,
    /// so the cache turns it into the same single allocation as the field used to be, with the
    /// added property that swapping <c>gpt-5-nano</c> for <c>Phi-4-mini-instruct</c> in
    /// configuration produces a fresh options instance on the next call.
    /// </remarks>
    private ChatOptions BuildDecisionOptions(string deployment)
        => _optionsCache.GetOrBuild(
            gameKey: AIFoundryOptions.Games.Survive,
            deployment: deployment,
            capabilityOverrides: _capabilityOverrides ?? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase),
            schema: AgentDecisionSchema,
            schemaName: "agent_decision",
            maxOutputTokens: MaxOutputTokens,
            schemaDescription: "One survival agent's chosen action and a short rationale.",
            factory: (d, ov) => AiDecisionChatOptions.ForStructuredJson(
                AgentDecisionSchema,
                schemaName: "agent_decision",
                maxOutputTokens: MaxOutputTokens,
                deployment: d ?? string.Empty,
                schemaDescription: "One survival agent's chosen action and a short rationale.",
                capabilityOverrides: ov));

    private static ChatOptions DecisionOptionsFor(string deployment) =>
        AiDecisionChatOptions.ForStructuredDecision(
            AgentDecisionSchema,
            schemaName: "agent_decision",
            maxOutputTokens: MaxOutputTokens,
            schemaDescription: "One survival agent's chosen action and a short rationale.");

    // Kept short: the schema now carries the output contract, so the prompt only has to carry the
    // role and the brevity budget. "max 12 words" alone did not hold — a schema-constrained run
    // still returned a 30-word thought, which is why `thought` also has a maxLength above.
    private const string SimulationSystemPrompt =
        "You are one survival agent on a 2D grid. Choose the single best action for the agent " +
        "described as \"self\", given the nearby agents, food and rocks. Keep \"thought\" under " +
        "twelve words.";

    private static string BuildUserPrompt(string gridJson, PersonalityDnaDto dna) =>
        $"grid={gridJson}; dna={JsonSerializer.Serialize(dna, PoSurviveJsonContext.Default.PersonalityDnaDto)}";

    private static string Truncate(string? text, int max)
        => string.IsNullOrEmpty(text) ? "(empty)"
         : text.Length <= max ? text
         : text[..max] + "…";

    /// <summary>
    /// Parses the model's reply, or returns null when there is nothing usable in it.
    /// </summary>
    /// <remarks>
    /// Still tolerant of prose around the JSON — the schema makes that unnecessary for a compliant
    /// provider, but a defensive parser costs nothing and the fallback path (a legacy key-based
    /// deployment that predates structured output) can still hit it.
    /// </remarks>
    private static InferenceResult? ParseInferenceResult(string? raw)
    {
        var start = raw?.IndexOf('{') ?? -1;
        var end = raw?.LastIndexOf('}') ?? -1;
        if (raw is null || start < 0 || end <= start)
            return null;

        try
        {
            using var doc = JsonDocument.Parse(raw[start..(end + 1)]);
            var root = doc.RootElement;

            if (!root.TryGetProperty("action", out var a) || a.ValueKind != JsonValueKind.String)
                return null;

            var thought = root.TryGetProperty("thought", out var t) && t.ValueKind == JsonValueKind.String
                ? t.GetString()!
                : string.Empty;

            return new InferenceResult(Thought: thought, Action: a.GetString()!);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

/// <summary>
/// Stand-in cache used when the service is constructed without a real
/// <see cref="AiDecisionOptionsCache"/> (the legacy api-key registration path in
/// <c>PoSurviveServiceExtensions</c>). Rebuilds the options per call — documented as ~5 µs.
/// </summary>
file sealed class NullOptionsCache : IAiDecisionOptionsCache
{
    public static readonly NullOptionsCache Instance = new();

    public ChatOptions GetOrBuild(
        string gameKey, string deployment, IReadOnlyDictionary<string, string> capabilityOverrides,
        System.Text.Json.JsonElement schema, string schemaName, int maxOutputTokens,
        string? schemaDescription,
        Func<string, IReadOnlyDictionary<string, string>, ChatOptions> factory)
        => factory(deployment, capabilityOverrides);

    public ChatOptions GetOrBuildText(
        string gameKey, string deployment, IReadOnlyDictionary<string, string> capabilityOverrides,
        int maxOutputTokens,
        Func<string, IReadOnlyDictionary<string, string>, ChatOptions> factory)
        => factory(deployment, capabilityOverrides);

    public int Count => 0;
}

/// <summary>
/// Thrown when the model answered but the answer contains no decision — an empty completion or
/// text that carries no <c>action</c>. Distinct from a transport failure so the relay can report
/// it as a gateway error rather than passing a fabricated "Idle" back to the game.
/// </summary>
public sealed class InferenceResponseUnusableException : Exception
{
    public InferenceResponseUnusableException(int rawLength)
        : base($"The model returned no usable decision (rawLength={rawLength}).")
        => RawLength = rawLength;

    /// <summary>Length of the reply text. Zero means the output budget was spent before any text.</summary>
    public int RawLength { get; }
}
