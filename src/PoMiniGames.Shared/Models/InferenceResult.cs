namespace PoMiniGames.Shared.Simulation.Models;

/// <summary>Returned by IInferenceService.InferAsync.</summary>
public record InferenceResult(
    string Thought,  // Natural-language narration from the LLM
    string Action    // "Attack" | "Forage" | "Flee" | "Idle"
);
