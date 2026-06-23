namespace PoSurvive.Shared.Models;

/// <summary>Used as input to IInferenceService.InferAsync.</summary>
public record PersonalityDnaDto(
    float Predatory,
    float Scavenger,
    float Paranoid,
    float Altruistic,
    float Methodical
);
