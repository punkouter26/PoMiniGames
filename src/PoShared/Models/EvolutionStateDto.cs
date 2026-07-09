namespace PoShared.Simulation.Models;

/// <summary>DTO representing the full evolution state for a DNA lineage.</summary>
public sealed record EvolutionStateDto(
    string Id,
    string DnaId,
    float Predatory,
    float Scavenger,
    float Paranoid,
    float Altruistic,
    float Methodical,
    int Generation,
    string? SourceSessionId,
    List<string> ParentDnaIds,
    string? Archetype,
    string DominantTrait,
    DateTimeOffset CreatedAt,
    int WinCount,
    int TotalSessions,
    float WinRate,
    int TotalKills,
    int TotalFoodConsumed,
    int TotalDamageDealt
);

/// <summary>DTO for evolution tree visualization — node + edges.</summary>
public sealed record EvolutionTreeNodeDto(
    string DnaId,
    string Label,
    int Generation,
    string DominantTrait,
    string? Archetype,
    float WinRate,
    int WinCount,
    List<string> ChildrenIds
);

/// <summary>DTO for the full evolution tree.</summary>
public sealed record EvolutionTreeDto(
    List<EvolutionTreeNodeDto> Nodes
);

/// <summary>Request body for evolving DNA via LLM prompt.</summary>
public sealed record EvolutionRequestDto(
    string ParentDnaId,
    string? StrategyPrompt
);

/// <summary>Summary stats for the Evolution Lab dashboard.</summary>
public sealed record EvolutionSummaryDto(
    int TotalLineages,
    int TotalGenerations,
    int MaxGeneration,
    int TotalSessions,
    float AverageWinRate,
    string TopArchetype,
    string TopDominantTrait,
    int UniqueDnaCount
);