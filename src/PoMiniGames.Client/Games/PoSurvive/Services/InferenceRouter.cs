namespace PoMiniGamesClient.Games.PoSurvive.Services;

using PoShared.Simulation.Interfaces;
using PoShared.Simulation.Models;

/// <summary>
/// GoF: Strategy proxy — routes InferAsync to either the local WebLLM service
/// or the remote Azure OpenAI relay based on the user's current model selection.
/// SOLID: OCP — new inference backends can be added without changing callers.
/// </summary>
public sealed class InferenceRouter : IInferenceService
{
    private readonly WebLlmInferenceService _local;
    private readonly RemoteRelayInferenceService _remote;
    private IInferenceService _active;

    public InferenceRouter(WebLlmInferenceService local, RemoteRelayInferenceService remote)
    {
        _local = local;
        _remote = remote;
        _active = local; // default to local WebLLM
    }

    /// <summary>Route all subsequent inference calls through the local WebLLM worker.</summary>
    public void UseLocal() => _active = _local;

    /// <summary>
    /// Route all subsequent inference calls through the server relay for the given
    /// Azure OpenAI model ID (e.g. "gpt-4.1-nano").
    /// </summary>
    public void UseRemote(string modelId)
    {
        _remote.SetModelId(modelId);
        _active = _remote;
    }

    /// <inheritdoc/>
    public Task<InferenceResult> InferAsync(
        string gridJson,
        PersonalityDnaDto dna,
        CancellationToken ct = default)
        => _active.InferAsync(gridJson, dna, ct);
}
