namespace PoMiniGames.Domain.ValueObjects.Simulation;

// GoF: Value Object — immutable, identity-less, equality by value
// LLM Evolution: Added generation metadata for tracking evolutionary lineage
public sealed record PersonalityDna
{
    public float Predatory { get; }
    public float Scavenger { get; }
    public float Paranoid { get; }
    public float Altruistic { get; }
    public float Methodical { get; }

    // ─── Evolution metadata (LLM-Powered Agent Evolution) ─────────────────
    /// <summary>Evolution generation number (0 = original seed, 1+ = evolved).</summary>
    public int Generation { get; init; }

    /// <summary>ID of the session that produced this winning DNA.</summary>
    public string? SourceSessionId { get; init; }

    /// <summary>Parent DNA IDs that this DNA was derived from (empty for seed).</summary>
    public IReadOnlyList<string> ParentDnaIds { get; init; } = [];

    /// <summary>Archetype label assigned during evolution (e.g., "Aggressor", "Survivor").</summary>
    public string? Archetype { get; init; }

    /// <summary>UTC timestamp when this DNA was created/evolved.</summary>
    public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;

    /// <summary>Win count accumulated by this DNA across sessions.</summary>
    public int WinCount { get; init; }

    /// <summary>Total sessions this DNA has participated in.</summary>
    public int TotalSessions { get; init; }

    /// <summary>Win rate (0..1). Returns 0 if no sessions played.</summary>
    public float WinRate => TotalSessions > 0 ? (float)WinCount / TotalSessions : 0f;

    /// <summary>
    /// Constructs a PersonalityDna and normalises the weights (L1-normalisation) so they sum to 1.0.
    /// </summary>
    public PersonalityDna(float predatory, float scavenger, float paranoid, float altruistic, float methodical)
    {
        var total = predatory + scavenger + paranoid + altruistic + methodical;
        if (total <= 0f)
            throw new ArgumentException("At least one DNA weight must be positive.");

        Predatory = predatory / total;
        Scavenger = scavenger / total;
        Paranoid = paranoid / total;
        Altruistic = altruistic / total;
        Methodical = methodical / total;
    }

    /// <summary>The trait name with the highest normalised weight.</summary>
    public string DominantTrait
    {
        get
        {
            var traits = new (float Weight, string Name)[]
            {
                (Predatory,  nameof(Predatory)),
                (Scavenger,  nameof(Scavenger)),
                (Paranoid,   nameof(Paranoid)),
                (Altruistic, nameof(Altruistic)),
                (Methodical,  nameof(Methodical)),
            };

            var best = traits.MaxBy(t => t.Weight);
            return best.Name;
        }
    }

    /// <summary>
    /// Creates a mutated copy of this DNA with small random adjustments.
    /// Used by the EvolutionEngine for producing child variants.
    /// </summary>
    public PersonalityDna Mutate(Random rng, float mutationStrength = 0.15f)
    {
        float MutateTrait(float value)
        {
            var delta = (float)((rng.NextDouble() - 0.5) * 2.0 * mutationStrength);
            return Math.Clamp(value + delta, 0.05f, 0.95f);
        }

        return new PersonalityDna(
            MutateTrait(Predatory),
            MutateTrait(Scavenger),
            MutateTrait(Paranoid),
            MutateTrait(Altruistic),
            MutateTrait(Methodical))
        {
            Generation = this.Generation + 1,
            ParentDnaIds = [GetDnaId()],
            CreatedAt = DateTimeOffset.UtcNow,
        };
    }

    /// <summary>
    /// Creates a crossover between two parent DNAs, blending their traits.
    /// </summary>
    public static PersonalityDna Crossover(PersonalityDna parent1, PersonalityDna parent2, Random rng)
    {
        float Blend(float a, float b)
        {
            var ratio = (float)rng.NextDouble();
            return a * ratio + b * (1f - ratio);
        }

        return new PersonalityDna(
            Blend(parent1.Predatory, parent2.Predatory),
            Blend(parent1.Scavenger, parent2.Scavenger),
            Blend(parent1.Paranoid, parent2.Paranoid),
            Blend(parent1.Altruistic, parent2.Altruistic),
            Blend(parent1.Methodical, parent2.Methodical))
        {
            Generation = Math.Max(parent1.Generation, parent2.Generation) + 1,
            ParentDnaIds = [parent1.GetDnaId(), parent2.GetDnaId()],
            CreatedAt = DateTimeOffset.UtcNow,
        };
    }

    /// <summary>Generates a stable string identifier for this DNA configuration.</summary>
    public string GetDnaId()
    {
        return $"DNA-{Predatory:F3}-{Scavenger:F3}-{Paranoid:F3}-{Altruistic:F3}-{Methodical:F3}";
    }
}
