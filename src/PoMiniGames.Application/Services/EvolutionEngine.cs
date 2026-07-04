namespace PoSurvive.Application.Services;

using System.Text.Json;
using PoSurvive.Application.Interfaces;
using PoSurvive.Domain.Entities;
using PoSurvive.Domain.ValueObjects;
using PoSurvive.Shared.Models;

/// <summary>
/// Core engine for LLM-Powered Agent Evolution.
/// Tracks winning DNA patterns, applies mutation/adaptation,
/// generates archetype labels, and builds evolution tree data.
/// </summary>
public sealed class EvolutionEngine
{
    private readonly IEvolutionRepository _repository;
    private readonly Random _rng = new();

    // Archetype classification thresholds
    private const float ArchetypeThreshold = 0.30f;

    public EvolutionEngine(IEvolutionRepository repository)
    {
        _repository = repository;
    }

    // ─── Public API ────────────────────────────────────────────────────────

    /// <summary>
    /// Record a session result: increment win/loss stats for each agent's DNA.
    /// Called at the end of each simulation.
    /// </summary>
    public async Task RecordSessionOutcomeAsync(
        IReadOnlyList<(PersonalityDna Dna, string AgentId, string Team, bool IsWinner,
            int KillCount, int FoodConsumed, int DamageDealt)> agentResults,
        string sessionId,
        CancellationToken ct = default)
    {
        foreach (var (dna, _, _, isWinner, kills, food, damage) in agentResults)
        {
            var existing = await _repository.GetAsync(dna.GetDnaId(), ct);

            if (existing is null)
            {
                // First time seeing this DNA — create a new record
                var record = EvolutionRecord.FromDna(dna, sessionId);
                record.TotalSessions = 1;
                record.WinCount = isWinner ? 1 : 0;
                record.TotalKills = kills;
                record.TotalFoodConsumed = food;
                record.TotalDamageDealt = damage;
                record.Archetype = ClassifyArchetype(dna);

                await _repository.UpsertAsync(record, ct);
            }
            else
            {
                // Update existing record
                existing.TotalSessions++;
                existing.WinCount += isWinner ? 1 : 0;
                existing.TotalKills += kills;
                existing.TotalFoodConsumed += food;
                existing.TotalDamageDealt += damage;

                // Recompute archetype if not yet set
                if (string.IsNullOrWhiteSpace(existing.Archetype))
                {
                    var tempDna = new PersonalityDna(
                        existing.Predatory, existing.Scavenger,
                        existing.Paranoid, existing.Altruistic, existing.Methodical);
                    existing.Archetype = ClassifyArchetype(tempDna);
                }

                await _repository.UpsertAsync(existing, ct);
            }
        }
    }

    /// <summary>
    /// Generate an evolved child DNA using mutation from a parent that has high win rate.
    /// </summary>
    public async Task<PersonalityDna> EvolveDnaAsync(
        PersonalityDna parentDna,
        string? strategyPrompt = null,
        CancellationToken ct = default)
    {
        // Simple evolution: mutate the parent
        var child = parentDna.Mutate(_rng, mutationStrength: 0.12f);

        // Classify archetype
        child = child with { Archetype = ClassifyArchetype(child) };

        // Persist the new child DNA
        var record = EvolutionRecord.FromDna(child);
        record.Archetype = child.Archetype;
        await _repository.UpsertAsync(record, ct);

        return child;
    }

    /// <summary>
    /// Generate a crossover child from two high-performing parents.
    /// </summary>
    public async Task<PersonalityDna> CrossoverDnaAsync(
        PersonalityDna parent1,
        PersonalityDna parent2,
        CancellationToken ct = default)
    {
        var child = PersonalityDna.Crossover(parent1, parent2, _rng);
        child = child with { Archetype = ClassifyArchetype(child) };

        var record = EvolutionRecord.FromDna(child);
        record.Archetype = child.Archetype;
        await _repository.UpsertAsync(record, ct);

        return child;
    }

    /// <summary>
    /// Get the top N performing DNAs by win rate (minimum 1 session).
    /// </summary>
    public async Task<IReadOnlyList<PersonalityDna>> GetTopPerformersAsync(
        int count = 5,
        CancellationToken ct = default)
    {
        var all = await _repository.GetAllAsync(ct);

        return all
            .Where(r => r.TotalSessions > 0)
            .OrderByDescending(r => (float)r.WinCount / r.TotalSessions)
            .ThenByDescending(r => r.WinCount)
            .Take(count)
            .Select(MapToDna)
            .ToList();
    }

    /// <summary>
    /// Build the full evolution tree for visualization.
    /// </summary>
    public async Task<EvolutionTreeDto> BuildEvolutionTreeAsync(CancellationToken ct = default)
    {
        var all = await _repository.GetAllAsync(ct);
        var allRecords = all.ToList();

        if (allRecords.Count == 0)
            return new EvolutionTreeDto([]);

        var nodes = new List<EvolutionTreeNodeDto>();

        // Build parent-child relationships from ParentDnaIdsJson
        var childMap = new Dictionary<string, List<string>>(); // parentDnaId -> childDnaIds
        foreach (var record in allRecords)
        {
            var parentIds = JsonSerializer.Deserialize(record.ParentDnaIdsJson, EvolutionJsonContext.Default.ListString) ?? [];
            foreach (var parentId in parentIds)
            {
                if (!childMap.ContainsKey(parentId))
                    childMap[parentId] = [];
                childMap[parentId].Add(record.DnaId);
            }
        }

        foreach (var record in allRecords)
        {
            childMap.TryGetValue(record.DnaId, out var children);
            var archetype = record.Archetype;
            if (string.IsNullOrWhiteSpace(archetype))
            {
                var tempDna = new PersonalityDna(
                    record.Predatory, record.Scavenger,
                    record.Paranoid, record.Altruistic, record.Methodical);
                archetype = ClassifyArchetype(tempDna);
            }

            nodes.Add(new EvolutionTreeNodeDto(
                DnaId:         record.DnaId,
                Label:         $"{archetype}-G{record.Generation}",
                Generation:    record.Generation,
                DominantTrait: record.DominantTrait,
                Archetype:     archetype,
                WinRate:       record.TotalSessions > 0 ? (float)record.WinCount / record.TotalSessions : 0f,
                WinCount:      record.WinCount,
                ChildrenIds:   children ?? []
            ));
        }

        return new EvolutionTreeDto(nodes);
    }

    /// <summary>
    /// Get all evolution state DTOs.
    /// </summary>
    public async Task<IReadOnlyList<EvolutionStateDto>> GetAllStatesAsync(CancellationToken ct = default)
    {
        var all = await _repository.GetAllAsync(ct);

        return all.Select(r => new EvolutionStateDto(
            Id:                r.DnaId,
            DnaId:             r.DnaId,
            Predatory:         r.Predatory,
            Scavenger:         r.Scavenger,
            Paranoid:          r.Paranoid,
            Altruistic:        r.Altruistic,
            Methodical:        r.Methodical,
            Generation:        r.Generation,
            SourceSessionId:   string.IsNullOrWhiteSpace(r.SourceSessionId) ? null : r.SourceSessionId,
            ParentDnaIds:      JsonSerializer.Deserialize(r.ParentDnaIdsJson, EvolutionJsonContext.Default.ListString) ?? [],
            Archetype:         string.IsNullOrWhiteSpace(r.Archetype) ? null : r.Archetype,
            DominantTrait:     r.DominantTrait,
            CreatedAt:         r.CreatedAt,
            WinCount:          r.WinCount,
            TotalSessions:     r.TotalSessions,
            WinRate:           r.TotalSessions > 0 ? (float)r.WinCount / r.TotalSessions : 0f,
            TotalKills:        r.TotalKills,
            TotalFoodConsumed: r.TotalFoodConsumed,
            TotalDamageDealt:  r.TotalDamageDealt
        )).ToList();
    }

    /// <summary>
    /// Get evolution summary stats.
    /// </summary>
    public async Task<EvolutionSummaryDto> GetSummaryAsync(CancellationToken ct = default)
    {
        var all = await _repository.GetAllAsync(ct);
        var records = all.ToList();

        if (records.Count == 0)
            return new EvolutionSummaryDto(0, 0, 0, 0, 0f, "None", "None", 0);

        var archetypeCounts = records
            .Where(r => !string.IsNullOrWhiteSpace(r.Archetype))
            .GroupBy(r => r.Archetype!)
            .Select(g => (Archetype: g.Key, Count: g.Count()))
            .OrderByDescending(x => x.Count)
            .ToList();

        var traitCounts = records
            .GroupBy(r => r.DominantTrait)
            .Select(g => (Trait: g.Key, Count: g.Count()))
            .OrderByDescending(x => x.Count)
            .ToList();

        return new EvolutionSummaryDto(
            TotalLineages:    records.Select(r => r.Generation == 0 ? r.DnaId : null).Where(id => id is not null).Distinct().Count(),
            TotalGenerations: records.Max(r => r.Generation),
            MaxGeneration:    records.Max(r => r.Generation),
            TotalSessions:    records.Sum(r => r.TotalSessions),
            AverageWinRate:   records.Where(r => r.TotalSessions > 0).Select(r => (float)r.WinCount / r.TotalSessions).DefaultIfEmpty(0f).Average(),
            TopArchetype:     archetypeCounts.FirstOrDefault().Archetype ?? "None",
            TopDominantTrait: traitCounts.FirstOrDefault().Trait ?? "None",
            UniqueDnaCount:   records.Count
        );
    }

    /// <summary>
    /// Seed the evolution store with initial random DNA configurations.
    /// </summary>
    public async Task SeedInitialDnaAsync(int count = 8, CancellationToken ct = default)
    {
        var existing = await _repository.GetAllAsync(ct);
        if (existing.Count > 0)
            return; // Already seeded

        for (var i = 0; i < count; i++)
        {
            var dna = GenerateRandomDna();
            var record = EvolutionRecord.FromDna(dna);
            record.Archetype = ClassifyArchetype(dna);
            record.Generation = 0;
            await _repository.UpsertAsync(record, ct);
        }
    }

    /// <summary>Reset all evolution data.</summary>
    public async Task ResetAsync(CancellationToken ct = default)
    {
        await _repository.DeleteAllAsync(ct);
    }

    // ─── Private helpers ──────────────────────────────────────────────────

    private PersonalityDna GenerateRandomDna()
    {
        return new PersonalityDna(
            (float)(_rng.NextDouble() * 0.9 + 0.1),
            (float)(_rng.NextDouble() * 0.9 + 0.1),
            (float)(_rng.NextDouble() * 0.9 + 0.1),
            (float)(_rng.NextDouble() * 0.9 + 0.1),
            (float)(_rng.NextDouble() * 0.9 + 0.1));
    }

    /// <summary>
    /// Classify a DNA into an archetype based on trait distribution.
    /// </summary>
    public static string ClassifyArchetype(PersonalityDna dna)
    {
        if (dna.Predatory >= ArchetypeThreshold)
            return dna.Paranoid >= 0.25f ? "Ambusher" : "Aggressor";
        if (dna.Scavenger >= ArchetypeThreshold)
            return dna.Methodical >= 0.25f ? "Collector" : "Scavenger";
        if (dna.Paranoid >= ArchetypeThreshold)
            return dna.Altruistic >= 0.20f ? "Guardian" : "Coward";
        if (dna.Altruistic >= ArchetypeThreshold)
            return "Diplomat";
        if (dna.Methodical >= ArchetypeThreshold)
            return dna.Predatory >= 0.20f ? "Tactician" : "Survivor";

        return "Generalist";
    }

    private static PersonalityDna MapToDna(EvolutionRecord r) =>
        new(r.Predatory, r.Scavenger, r.Paranoid, r.Altruistic, r.Methodical)
        {
            Generation = r.Generation,
            SourceSessionId = r.SourceSessionId,
            Archetype = r.Archetype,
            CreatedAt = r.CreatedAt,
            WinCount = r.WinCount,
            TotalSessions = r.TotalSessions,
        };
}