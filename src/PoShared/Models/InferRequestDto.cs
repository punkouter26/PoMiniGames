namespace PoSurvive.Shared.Models;

/// <summary>
/// Request body for POST /api/infer.
/// Shared between Client (relay caller) and Server (endpoint handler).
/// </summary>
public sealed record InferRequestDto(
    string            GridJson,
    PersonalityDnaDto Dna,
    /// <summary>
    /// Optional model identifier (e.g. "gpt-4.1-nano") that maps to a specific
    /// Azure OpenAI deployment on the server. When null, the server uses its
    /// configured default deployment.
    /// </summary>
    string?           ModelId = null
);
