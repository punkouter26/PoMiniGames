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
        var response = await _chat.GetResponseAsync(messages, cancellationToken: ct);
        return ParseInferenceResult(response.Text);
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

    private const string SimulationSystemPrompt =
        "You are a survival agent in a 2D grid. Respond with a single JSON line: " +
        "{\"action\": \"Attack|Forage|Flee|Idle\", \"thought\": \"<short>\"}.";

    private static string BuildUserPrompt(string gridJson, PersonalityDnaDto dna) =>
        $"grid={gridJson}; dna={System.Text.Json.JsonSerializer.Serialize(dna)}";

    private static InferenceResult ParseInferenceResult(string raw)
    {
        // Defensive: the model sometimes emits prose around the JSON line. Pull the first
        // { … } block and deserialize.
        var start = raw.IndexOf('{');
        var end = raw.LastIndexOf('}');
        if (start < 0 || end <= start)
        {
            return new InferenceResult(Thought: "unparseable model response", Action: "Idle");
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
            return new InferenceResult(Thought: "parse_error", Action: "Idle");
        }
    }
}
