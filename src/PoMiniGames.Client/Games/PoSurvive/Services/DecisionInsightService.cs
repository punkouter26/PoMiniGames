using PoShared.Simulation.Models;
using PoMiniGamesClient.Games.PoSurvive.Store;

namespace PoMiniGamesClient.Games.PoSurvive.Services;

public sealed class DecisionInsightService
{
    public string GetSeverity(ConsoleEntry entry)
    {
        if (entry.Thought.Contains("error", StringComparison.OrdinalIgnoreCase)
            || entry.Thought.Contains("timed out", StringComparison.OrdinalIgnoreCase)
            || entry.Thought.Contains("timeout", StringComparison.OrdinalIgnoreCase)
            || entry.Thought.Contains("unavailable", StringComparison.OrdinalIgnoreCase))
        {
            return "warn";
        }

        return "info";
    }

    // Plain-language, one-sentence "why did it do that?" summary — the hero line
    // that sits atop the Decision Inspector so a non-expert reads the intent
    // before any of the technical breakdown below it.
    public string BuildPlainSummary(AgentDto? agent, ConsoleEntry? entry)
    {
        if (agent is null || entry is null)
            return "Watch the grid, then follow an agent to see why it moves.";

        var action = (entry.Action ?? "idle").ToLowerInvariant();
        var topTrait = GetSortedTraits(agent).First().Key.ToLowerInvariant();
        var lowHp = agent.Hp <= 35;
        var hungry = agent.Hunger >= 0.6f;

        var verb = action switch
        {
            "attack" => "went on the attack",
            "forage" => "went looking for food",
            "flee" => "backed away from danger",
            _ => "held its position",
        };

        var reason = action switch
        {
            "attack" => topTrait == "predatory"
                ? "an enemy was in reach and it's a natural hunter"
                : "an enemy was in reach",
            "forage" => hungry ? "it's getting hungry" : "food was close by",
            "flee" => lowHp ? "its health is running low" : "a threat was closing in",
            _ => "nothing nearby was worth the risk",
        };

        return $"{agent.Id} {verb} — {reason}.";
    }

    public IEnumerable<KeyValuePair<string, int>> GetSortedTraits(AgentDto agent)
    {
        var traits = new Dictionary<string, int>
        {
            ["Predatory"] = (int)Math.Round(agent.Predatory * 100),
            ["Scavenger"] = (int)Math.Round(agent.Scavenger * 100),
            ["Paranoid"] = (int)Math.Round(agent.Paranoid * 100),
            ["Altruistic"] = (int)Math.Round(agent.Altruistic * 100),
            ["Methodical"] = (int)Math.Round(agent.Methodical * 100),
        };

        return traits.OrderByDescending(t => t.Value);
    }

    public IReadOnlyList<ActionOption> BuildActionOptions(AgentDto agent, ConsoleEntry entry, IReadOnlyList<ConsoleEntry> history)
    {
        var thought = entry.Thought;
        var dangerHint = ContainsAny(thought, "danger", "threat", "surrounded", "retreat", "flee", "low hp");
        var resourceHint = ContainsAny(thought, "food", "hunger", "forage", "starving", "supply");
        var attackHint = ContainsAny(thought, "attack", "strike", "target", "finish", "eliminate");

        var hpPressure = 100 - agent.Hp;
        var hungerPressure = (int)Math.Round(agent.Hunger * 100);
        var recentAggro = history.Count(h => string.Equals(h.Action, "Attack", StringComparison.OrdinalIgnoreCase));
        var recentFlee = history.Count(h => string.Equals(h.Action, "Flee", StringComparison.OrdinalIgnoreCase));

        var attackScore =
            (int)Math.Round(agent.Predatory * 58)
            + (int)Math.Round(agent.Methodical * 8)
            + Math.Min(agent.KillCount * 6, 18)
            + Math.Min(recentAggro * 4, 12)
            + (attackHint ? 15 : 0)
            - (dangerHint ? 8 : 0);

        var forageScore =
            (int)Math.Round(agent.Scavenger * 52)
            + (int)Math.Round(hungerPressure * 0.45)
            + (resourceHint ? 14 : 0)
            + (agent.FoodConsumed < 2 ? 6 : 0)
            - (dangerHint ? 6 : 0);

        var fleeScore =
            (int)Math.Round(agent.Paranoid * 56)
            + (int)Math.Round(hpPressure * 0.48)
            + Math.Min(recentFlee * 5, 12)
            + (dangerHint ? 14 : 0)
            - (attackHint ? 6 : 0);

        var idleScore =
            (int)Math.Round(agent.Methodical * 48)
            + (int)Math.Round(agent.Altruistic * 8)
            + (hpPressure < 25 && hungerPressure < 30 ? 10 : 0)
            - (dangerHint ? 10 : 0)
            - (resourceHint ? 6 : 0);

        var options = new List<ActionOption>
        {
            new(
                "Attack",
                ClampScore(attackScore),
                string.Equals(entry.Action, "Attack", StringComparison.OrdinalIgnoreCase),
                "Favored by predatory drive, elimination momentum, and target cues."),
            new(
                "Forage",
                ClampScore(forageScore),
                string.Equals(entry.Action, "Forage", StringComparison.OrdinalIgnoreCase),
                "Favored when hunger/resource pressure outweighs direct combat value."),
            new(
                "Flee",
                ClampScore(fleeScore),
                string.Equals(entry.Action, "Flee", StringComparison.OrdinalIgnoreCase),
                "Favored by risk cues, low survivability, and paranoid tendency."),
            new(
                "Idle",
                ClampScore(idleScore),
                string.Equals(entry.Action, "Idle", StringComparison.OrdinalIgnoreCase),
                "Favored during low pressure windows when setup beats commitment.")
        };

        return options.OrderByDescending(o => o.Score).ToList();
    }

    public int ComputeConfidence(AgentDto? agent, ConsoleEntry? entry, IReadOnlyList<ConsoleEntry> history)
    {
        if (agent is null || entry is null)
            return 0;

        var options = BuildActionOptions(agent, entry, history);
        if (options.Count < 2)
            return 0;

        var ordered = options.OrderByDescending(o => o.Score).ToList();
        return Math.Clamp(ordered[0].Score - ordered[1].Score, 0, 100);
    }

    public IReadOnlyList<DecisionFactor> BuildCausalityFactors(AgentDto? agent, ConsoleEntry? entry, IReadOnlyList<ConsoleEntry> history)
    {
        if (agent is null || entry is null)
            return [];

        var topTrait = GetSortedTraits(agent).First();
        var pressure = Math.Clamp((100 - agent.Hp) + (int)Math.Round(agent.Hunger * 100), 0, 200);
        var pressureLabel = pressure switch
        {
            >= 130 => "HIGH",
            >= 80 => "MEDIUM",
            _ => "LOW"
        };

        var contextSignal = DetectContextSignal(entry.Thought);
        var momentum = DetectMomentum(history);

        return
        [
            new DecisionFactor(
                "Primary drive",
                $"{topTrait.Key} {topTrait.Value}%",
                "drive",
                "Highest DNA trait currently exerts the strongest baseline pull."),
            new DecisionFactor(
                "Pressure",
                pressureLabel,
                pressure >= 130 ? "risk" : "drive",
                $"Derived from HP and hunger stress index ({pressure}/200)."),
            new DecisionFactor(
                "Context cue",
                contextSignal.Title,
                contextSignal.Polarity,
                contextSignal.Detail),
            new DecisionFactor(
                "Momentum",
                momentum.Title,
                momentum.Polarity,
                momentum.Detail)
        ];
    }

    public ContextSignal DetectContextSignal(string thought)
    {
        if (ContainsAny(thought, "danger", "threat", "retreat", "surrounded", "under attack"))
            return new ContextSignal("Threat detected", "risk", "Thought text indicates immediate danger in local context.");

        if (ContainsAny(thought, "food", "forage", "hunger", "resource"))
            return new ContextSignal("Resource opportunity", "drive", "Thought text indicates resource-seeking opportunity.");

        if (ContainsAny(thought, "target", "attack", "kill", "finish"))
            return new ContextSignal("Engagement window", "drive", "Thought text indicates target lock or attack opportunity.");

        return new ContextSignal("Neutral scan", "drive", "No dominant cue; baseline trait mix likely drove action.");
    }

    public ContextSignal DetectMomentum(IReadOnlyList<ConsoleEntry> history)
    {
        if (history.Count == 0)
            return new ContextSignal("No prior turns", "drive", "Insufficient history for momentum signal.");

        var lastThree = history.TakeLast(3).ToList();
        var dominant = lastThree
            .GroupBy(h => h.Action, StringComparer.OrdinalIgnoreCase)
            .OrderByDescending(g => g.Count())
            .First();

        var action = dominant.Key.ToUpperInvariant();
        var count = dominant.Count();
        var polarity = string.Equals(dominant.Key, "Flee", StringComparison.OrdinalIgnoreCase) ? "risk" : "drive";

        return new ContextSignal(
            $"{action} x{count}",
            polarity,
            "Recent action sequence biases the current turn toward behavioral continuity.");
    }

    private static bool ContainsAny(string source, params string[] needles)
        => needles.Any(n => source.Contains(n, StringComparison.OrdinalIgnoreCase));

    private static int ClampScore(int score)
        => Math.Clamp(score, 0, 100);
}

public sealed record ActionOption(string ActionName, int Score, bool IsCurrent, string Rationale);
public sealed record DecisionFactor(string Title, string Value, string Polarity, string Detail);
public sealed record ContextSignal(string Title, string Polarity, string Detail);
