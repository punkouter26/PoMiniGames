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
public sealed class AzureOpenAIInferenceService : IInferenceService
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
    private readonly ILogger<AzureOpenAIInferenceService> _logger;

    public AzureOpenAIInferenceService(
        IChatClient chat,
        IReadOnlyDictionary<string, string>? deploymentMap = null,
        ILogger<AzureOpenAIInferenceService>? logger = null,
        Func<string, IChatClient?>? clientForDeployment = null)
    {
        _chat = chat;
        _deploymentMap = deploymentMap ?? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        _clientForDeployment = clientForDeployment;
        _logger = logger ?? Microsoft.Extensions.Logging.Abstractions.NullLogger<AzureOpenAIInferenceService>.Instance;
    }

    /// <inheritdoc />
    public Task<InferenceResult> InferAsync(string gridJson, PersonalityDnaDto dna, CancellationToken ct = default)
        => InferWithClientAsync(_chat, gridJson, dna, ct);

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
        var chat = ResolveClient(modelId) ?? _chat;
        return InferWithClientAsync(chat, gridJson, dna, ct);
    }

    private IChatClient? ResolveClient(string? modelId)
    {
        if (string.IsNullOrWhiteSpace(modelId) || _clientForDeployment is null)
            return null;

        // Only ids on the server-side allowlist may select a deployment.
        if (!_deploymentMap.TryGetValue(modelId!, out var deployment))
        {
            _logger.LogDebug(
                "Requested modelId={ModelId} is not on the server allowlist; serving from the default deployment.",
                modelId);
            return null;
        }

        return _clientForDeployment(deployment);
    }

    private async Task<InferenceResult> InferWithClientAsync(
        IChatClient chat, string gridJson, PersonalityDnaDto dna, CancellationToken ct)
    {
        var messages = new List<ChatMessage>
        {
            new(ChatRole.System, SimulationSystemPrompt),
            new(ChatRole.User,   BuildUserPrompt(gridJson, dna)),
        };

        var response = await chat.GetResponseAsync(messages, DecisionOptions, ct);
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
    /// Bounded output plus minimal reasoning effort plus a strict schema — built once and shared,
    /// since it never varies per call. See <see cref="AiDecisionChatOptions"/> for why all three
    /// have to travel together.
    /// </summary>
    private static readonly ChatOptions DecisionOptions = AiDecisionChatOptions.ForStructuredDecision(
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
