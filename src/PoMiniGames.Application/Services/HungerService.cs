namespace PoSurvive.Application.Services;

using PoSurvive.Application.DTOs;
using PoSurvive.Domain.Entities;

// SOLID: SRP — owns only hunger accumulation and starvation HP loss; no combat or movement
public sealed class HungerService
{
    /// <summary>
    /// Increments an agent's hunger by λ (HungerDecayConstant) and applies
    /// starvation HP loss when hunger ≥ HungerThreshold.
    /// </summary>
    public void ApplyHunger(Agent agent, SimulationConfig config)
    {
        agent.Hunger = Math.Min(1f, agent.Hunger + config.HungerDecayConstant);

        if (agent.Hunger >= config.HungerThreshold)
        {
            agent.Hp -= config.StarveHpLossPerTurn;
            if (!agent.IsAlive)
                agent.IsFading = true;
        }
    }

    /// <summary>Resets hunger to 0.0 when an agent eats a food node.</summary>
    public void ConsumeFood(Agent agent)
    {
        agent.Hunger    = 0f;
        agent.FoodConsumed++;
    }
}
