using Microsoft.Extensions.AI;
using PoShared.Simulation.Interfaces;
using PoShared.Simulation.Models;

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
// slice's storage boundary), and the namespace was renamed to
// `PoSurvive.Server.Storage` to match the rest of the PoSurvive
// server-side organisation.
public sealed class AzureOpenAIInferenceService : IInferenceService
{
    private readonly IChatClient _chat;
    private readonly IReadOnlyDictionary<string, string> _deploymentMap;
    private readonly ILogger<AzureOpenAIInferenceService> _logger;

    public AzureOpenAIInferenceService(
        IChatClient chat,
        IReadOnlyDictionary<string, string>? deploymentMap = null,
        ILogger<AzureOpenAIInferenceService>? logger = null)
    {
        _chat = chat;
        _deploymentMap = deploymentMap ?? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        _logger = logger ?? Microsoft.Extensions.Logging.Abstractions.NullLogger<AzureOpenAIInferenceService>.Instance;
    }

    /// <inheritdoc />
    public async Task<InferenceResult> InferAsync(string gridJson, PersonalityDnaDto dna, CancellationToken ct = default)
    {
        var messages = new List<ChatMessage>
        {
            new(ChatRole.System, SimulationSystemPrompt),
            new(ChatRole.User,   BuildUserPrompt(gridJson, dna)),
        };
        // Bounded output. The reply is one short JSON object, but nothing capped it, so the
        // model was free to ramble and a measured round trip ran ~4.6 s — long enough that
        // the simulation's per-turn budget cancelled the call before the answer landed. A
        // hard ceiling cuts the latency that matters here and the per-call token cost with it.
        var response = await _chat.GetResponseAsync(messages, ChatOptions, ct);
        var parsed = ParseInferenceResult(response.Text);

        // The two parse failures are indistinguishable in the UI otherwise — both surface as
        // a thought the player can't act on — but they have opposite causes: an empty
        // completion means the output budget was consumed before any text, while unparseable
        // text means the model ignored the JSON contract. Log the raw reply so the next
        // person doesn't have to bisect ChatOptions to find out which.
        if (parsed.Thought is UnparseableThought or ParseErrorThought)
        {
            _logger.LogWarning(
                "PoSurvive inference returned no usable JSON (reason={Reason}, rawLength={Length}). Raw: {Raw}",
                parsed.Thought,
                response.Text?.Length ?? 0,
                Truncate(response.Text, 300));
        }

        return parsed;
    }

    /// <summary>
    /// Per-request model selection. Resolves <paramref name="modelId"/> through
    /// <see cref="_deploymentMap"/>; falls back to the <see cref="IChatClient"/>'s
    /// default deployment when the id is unknown (or null/empty).
    /// </summary>
    public Task<InferenceResult> InferWithModelAsync(
        string gridJson,
        PersonalityDnaDto dna,
        string? modelId,
        CancellationToken ct = default)
    {
        // The shared IChatClient is bound to a single deployment at construction time
        // (AIFoundryChatClientCache.Resolve(gameKey)). Per-request deployment switching
        // would require an IChatClient per deployment — out of scope for the cloud
        // relay use case. We honour modelId only for logging/audit here.
        if (!string.IsNullOrWhiteSpace(modelId))
        {
            _logger.LogDebug("InferWithModelAsync called with modelId={ModelId}; using the chat client's pre-bound deployment.", modelId);
        }
        return InferAsync(gridJson, dna, ct);
    }

    /// <summary>
    /// No per-call options are sent, and that is a measured decision rather than an omission.
    /// </summary>
    /// <remarks>
    /// The deployment backing this game rejects or breaks under both of the obvious knobs:
    /// <list type="bullet">
    /// <item><b>Temperature.</b> Pinning it to 0 for determinism returned
    /// <c>HTTP 400 invalid_request_error / unsupported_value — 'temperature' does not support
    /// 0 with this model. Only the default (1) value is supported.</c> Every relayed call 503'd.</item>
    /// <item><b>MaxOutputTokens.</b> It reasons before emitting visible text, so a cap starves
    /// the answer instead of shortening it: 80 tokens and then 512 both produced a completion
    /// of <c>rawLength=0</c> — a successful 200 carrying nothing to parse. Uncapped, the same
    /// prompt returns the required JSON in ~4.5 s.</item>
    /// </list>
    /// Turn latency is therefore controlled where it actually belongs — the orchestrator runs
    /// a turn's agents concurrently, so a turn costs the slowest call rather than their sum —
    /// and the client's per-agent cancellation token remains the hard ceiling.
    /// </remarks>
    private static readonly ChatOptions? ChatOptions = null;

    private const string SimulationSystemPrompt =
        "You are a survival agent in a 2D grid. Respond with a single JSON line and nothing else: " +
        "{\"action\": \"Attack|Forage|Flee|Idle\", \"thought\": \"<max 12 words>\"}.";

    private static string BuildUserPrompt(string gridJson, PersonalityDnaDto dna) =>
        $"grid={gridJson}; dna={System.Text.Json.JsonSerializer.Serialize(dna)}";

    private const string UnparseableThought = "unparseable model response";
    private const string ParseErrorThought = "parse_error";

    private static string Truncate(string? text, int max)
        => string.IsNullOrEmpty(text) ? "(empty)"
         : text.Length <= max ? text
         : text[..max] + "…";

    private static InferenceResult ParseInferenceResult(string raw)
    {
        // Defensive: the model sometimes emits prose around the JSON line. Pull the first
        // { … } block and deserialize.
        var start = raw?.IndexOf('{') ?? -1;
        var end = raw?.LastIndexOf('}') ?? -1;
        if (raw is null || start < 0 || end <= start)
        {
            return new InferenceResult(Thought: UnparseableThought, Action: "Idle");
        }
        var json = raw[start..(end + 1)];
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var root = doc.RootElement;
            var action = root.TryGetProperty("action", out var a) && a.ValueKind == System.Text.Json.JsonValueKind.String
                ? a.GetString()!
                : "Idle";
            var thought = root.TryGetProperty("thought", out var t) && t.ValueKind == System.Text.Json.JsonValueKind.String
                ? t.GetString()!
                : string.Empty;
            return new InferenceResult(Thought: thought, Action: action);
        }
        catch
        {
            return new InferenceResult(Thought: ParseErrorThought, Action: "Idle");
        }
    }
}
