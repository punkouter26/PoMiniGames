namespace PoSurvive.Application.Services;

using PoSurvive.Application.DTOs;
using PoSurvive.Domain.Entities;

// SOLID: SRP — owns only HP-damage calculation; no movement or state management
public sealed class CombatService
{
    /// <summary>
    /// Applies the combat formula to the defender.
    /// HP(t+1) = max(0, HP(t) - (BaseDamage × (Predatory + RNG)))
    /// where RNG = ±10% variance.
    /// Returns damage actually dealt (before clamp).
    /// </summary>
    public int Attack(Agent attacker, Agent defender, SimulationConfig config, Random rng)
    {
        // Combat formula from data-model.md
        var variance = rng.NextDouble() * 0.2 - 0.1;   // [-0.1, +0.1]
        var rawDamage = (int)Math.Round(
            config.BaseDamage * (attacker.Dna.Predatory + variance));

        rawDamage = Math.Max(1, rawDamage);             // always deal at least 1 damage

        attacker.TotalDamageDealt += rawDamage;
        defender.Hp -= rawDamage;

        if (!defender.IsAlive)
        {
            attacker.KillCount++;
            defender.IsFading = true;
        }

        return rawDamage;
    }
}
