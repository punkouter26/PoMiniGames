namespace PoMiniGames.Domain.Entities.Simulation;

using PoMiniGames.Domain.ValueObjects.Simulation;

/// <summary>
/// Persistence entity for storing evolution state of a DNA lineage.
/// Tracks DNA configuration, session outcomes, and lineage metadata.
/// </summary>
public sealed class EvolutionRecord
{
    /// <summary>Partition key: "evolution".</summary>
    public string PartitionKey { get; set; } = "evolution";

    /// <summary>Row key: unique DNA identifier.</summary>
    public string RowKey { get; set; } = string.Empty;

    /// <summary>Stable DNA ID string.</summary>
    public string DnaId { get; set; } = string.Empty;

    // ─── DNA trait values ─────────────────────────────────────────────────
    public float Predatory { get; set; }
    public float Scavenger { get; set; }
    public float Paranoid { get; set; }
    public float Altruistic { get; set; }
    public float Methodical { get; set; }

    // ─── Evolution metadata ────────────────────────────────────────────────
    public int Generation { get; set; }
    public string? SourceSessionId { get; set; }
    public string ParentDnaIdsJson { get; set; } = "[]"; // JSON array of parent DNA IDs
    public string? Archetype { get; set; }
    public string DominantTrait { get; set; } = string.Empty;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    // ─── Performance metrics ───────────────────────────────────────────────
    public int WinCount { get; set; }
    public int TotalSessions { get; set; }
    public int TotalKills { get; set; }
    public int TotalFoodConsumed { get; set; }
    public int TotalDamageDealt { get; set; }

    /// <summary>Creates an EvolutionRecord from a PersonalityDna.</summary>
    public static EvolutionRecord FromDna(PersonalityDna dna, string? sessionId = null)
    {
        return new EvolutionRecord
        {
            RowKey = dna.GetDnaId(),
            DnaId = dna.GetDnaId(),
            Predatory = dna.Predatory,
            Scavenger = dna.Scavenger,
            Paranoid = dna.Paranoid,
            Altruistic = dna.Altruistic,
            Methodical = dna.Methodical,
            Generation = dna.Generation,
            SourceSessionId = sessionId ?? dna.SourceSessionId,
            ParentDnaIdsJson = System.Text.Json.JsonSerializer.Serialize(
                dna.ParentDnaIds, EvolutionJsonContext.Default.IReadOnlyListString),
            Archetype = dna.Archetype,
            DominantTrait = dna.DominantTrait,
            CreatedAt = dna.CreatedAt,
            WinCount = dna.WinCount,
            TotalSessions = dna.TotalSessions,
        };
    }
}