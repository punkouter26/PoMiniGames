namespace PoSurvive.Client.Services;

using System.Net.Http.Json;
using PoSurvive.Shared.Interfaces;
using PoSurvive.Shared.Models;

/// <summary>
/// GoF: Strategy — client-side relay that calls POST /api/infer on the server,
/// which proxies the request to Azure OpenAI Foundry.
/// Activated when the user selects a remote model on the home screen.
/// The API key never leaves the server (Constitution Principle VI).
/// </summary>
public sealed class RemoteRelayInferenceService(HttpClient http) : IInferenceService
{
    private string? _modelId;

    /// <summary>Sets the Azure OpenAI model ID to use for subsequent inference calls.</summary>
    public void SetModelId(string? modelId) => _modelId = modelId;

    /// <inheritdoc/>
    public async Task<InferenceResult> InferAsync(
        string            gridJson,
        PersonalityDnaDto dna,
        CancellationToken ct = default)
    {
        var request  = new InferRequestDto(gridJson, dna, _modelId);
        var response = await http.PostAsJsonAsync("/api/infer", request, ct);
        response.EnsureSuccessStatusCode();
        var result = await response.Content.ReadFromJsonAsync<InferenceResult>(
            cancellationToken: ct);
        return result ?? new InferenceResult("No response from server relay.", "Idle");
    }
}
