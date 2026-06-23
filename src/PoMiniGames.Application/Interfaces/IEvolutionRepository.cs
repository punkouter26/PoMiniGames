namespace PoSurvive.Application.Interfaces;

using PoSurvive.Domain.Entities;

/// <summary>Repository for persisting and querying DNA evolution records.</summary>
public interface IEvolutionRepository
{
    /// <summary>Upsert a single evolution record.</summary>
    Task UpsertAsync(EvolutionRecord record, CancellationToken ct = default);

    /// <summary>Get an evolution record by DNA ID.</summary>
    Task<EvolutionRecord?> GetAsync(string dnaId, CancellationToken ct = default);

    /// <summary>Get all evolution records ordered by generation descending.</summary>
    Task<IReadOnlyList<EvolutionRecord>> GetAllAsync(CancellationToken ct = default);

    /// <summary>Get all records in a specific generation.</summary>
    Task<IReadOnlyList<EvolutionRecord>> GetByGenerationAsync(int generation, CancellationToken ct = default);

    /// <summary>Delete all evolution records (reset).</summary>
    Task DeleteAllAsync(CancellationToken ct = default);
}