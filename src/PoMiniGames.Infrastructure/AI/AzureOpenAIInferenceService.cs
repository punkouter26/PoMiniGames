namespace PoSurvive.Infrastructure.AI;

using Azure.AI.OpenAI;
using Microsoft.Extensions.AI;
using PoSurvive.Shared.Interfaces;
using PoSurvive.Shared.Models;

// GoF: Strategy — implements IInferenceService; activated only when Inference:UseCloudFallback=true
// SOLID: DIP — callers depend on IInferenceService; this class wires in Azure OpenAI via ME.AI
// Never exposed directly to the WASM client; accessed only through POST /api/infer relay (T076a)
public sealed class AzureOpenAIInferenceService : IInferenceService
{
    private readonly AzureOpenAIClient                     _openAiClient;
    private readonly string                               _defaultDeployment;
    private readonly IReadOnlyDictionary<string, string>  _deploymentMap;

    /// <param name="openAiClient">Authenticated Azure OpenAI client (shared).</param>
    /// <param name="defaultDeployment">Deployment name used when no model ID is specified.</param>
    /// <param name="deploymentMap">Allowlist mapping model IDs to Azure deployment names.</param>
    public AzureOpenAIInferenceService(
        AzureOpenAIClient                    openAiClient,
        string                               defaultDeployment,
        IReadOnlyDictionary<string, string>? deploymentMap = null)
    {
        _openAiClient      = openAiClient;
        _defaultDeployment = defaultDeployment;
        _deploymentMap     = deploymentMap ?? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    }

    /// <inheritdoc/>
    public Task<InferenceResult> InferAsync(
        string            gridJson,
        PersonalityDnaDto dna,
        CancellationToken ct = default)
        => InferWithDeploymentAsync(gridJson, dna, modelId: null, ct);

    /// <summary>
    /// Infers using the deployment resolved from <paramref name="modelId"/>.
    /// Falls back to the default deployment when <paramref name="modelId"/> is not in the allowlist.
    /// </summary>
    public Task<InferenceResult> InferWithModelAsync(
        string            gridJson,
        PersonalityDnaDto dna,
        string?           modelId,
        CancellationToken ct = default)
        => InferWithDeploymentAsync(gridJson, dna, modelId, ct);

    // ─── Private helpers ──────────────────────────────────────────────────────

    private async Task<InferenceResult> InferWithDeploymentAsync(
        string            gridJson,
        PersonalityDnaDto dna,
        string?           modelId,
        CancellationToken ct)
    {
        var deployment = ResolveDeployment(modelId);
        var chat       = _openAiClient.GetChatClient(deployment).AsIChatClient();

        var prompt =
            $"You are an autonomous survival agent. Your personality DNA: " +
            $"Predatory={dna.Predatory:F2}, Scavenger={dna.Scavenger:F2}, " +
            $"Paranoid={dna.Paranoid:F2}, Altruistic={dna.Altruistic:F2}, " +
            $"Methodical={dna.Methodical:F2}.\n\n" +
            $"Grid state: {gridJson}\n\n" +
            $"Respond in exactly this format:\n" +
            $"THOUGHT: <one sentence>\nACTION: <Attack|Forage|Flee|Idle>";

        var response = await chat.GetResponseAsync(prompt, cancellationToken: ct);
        return ParseResponse(response.Text ?? "");
    }

    private string ResolveDeployment(string? modelId)
    {
        if (!string.IsNullOrWhiteSpace(modelId)
            && _deploymentMap.TryGetValue(modelId, out var mapped))
            return mapped;

        return _defaultDeployment;
    }

    private static InferenceResult ParseResponse(string text)
    {
        var thought = "";
        var action  = "Idle";

        foreach (var line in text.Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            if (line.StartsWith("THOUGHT:", StringComparison.OrdinalIgnoreCase))
                thought = line[8..].Trim();
            else if (line.StartsWith("ACTION:", StringComparison.OrdinalIgnoreCase))
                action  = line[7..].Trim();
        }

        // Validate action is a known value; default to Idle for safety
        if (!new[] { "Attack", "Forage", "Flee", "Idle" }.Contains(action, StringComparer.OrdinalIgnoreCase))
            action = "Idle";

        return new InferenceResult(thought, action);
    }
}
