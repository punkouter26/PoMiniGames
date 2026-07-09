namespace PoShared.Simulation.Interfaces;

using PoShared.Simulation.Models;

// GoF: Strategy — multiple implementations: WebLlmInferenceService (client), AzureOpenAIInferenceService (server), MockInferenceService (tests)
// SOLID: DIP — callers depend on this interface, not on a concrete implementation
// Placed in PoSurvive.Shared so both PoSurvive.Client and PoSurvive.Infrastructure can implement it
// without circular project references.
public interface IInferenceService
{
    /// <summary>
    /// Requests an LLM-generated thought and action for an agent given the current grid state.
    /// </summary>
    /// <param name="gridJson">JSON-serialised GridStateDto (compact form).</param>
    /// <param name="dna">Agent's personality DNA to bias the response.</param>
    /// <param name="ct">Cancellation token — callers should honour InferenceTimeoutMs.</param>
    Task<InferenceResult> InferAsync(string gridJson, PersonalityDnaDto dna, CancellationToken ct = default);
}
