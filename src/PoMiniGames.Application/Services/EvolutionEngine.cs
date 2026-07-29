namespace PoMiniGames.Application.Simulation;

using PoMiniGames.Domain.Entities.Simulation;
using PoMiniGames.Domain.ValueObjects.Simulation;

/// <summary>
/// Core engine for LLM-Powered Agent Evolution: accumulates per-DNA win/loss statistics
/// across sessions and labels each pattern with an archetype.
///
/// The breeding and query surface (EvolveDnaAsync, CrossoverDnaAsync, GetTopPerformersAsync,
/// BuildEvolutionTreeAsync, GetAllStatesAsync, GetSummaryAsync, SeedInitialDnaAsync,
/// ResetAsync) was removed along with the /api/evolution/* endpoints that exposed it and
/// the EvolutionLab component that was their only consumer. Recording still runs on every
/// completed simulation, so the data keeps accumulating for whatever reads it next.
/// </summary>
public sealed class EvolutionEngine
{
    private readonly IEvolutionRepository _repository;

    // Archetype classification thresholds
    private const float ArchetypeThreshold = 0.30f;

    public EvolutionEngine(IEvolutionRepository repository)
    {
        _repository = repository;
    }

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
}
