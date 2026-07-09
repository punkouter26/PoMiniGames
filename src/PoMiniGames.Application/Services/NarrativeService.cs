namespace PoMiniGames.Application.Simulation;

using PoMiniGames.Application.Simulation;
using PoMiniGames.Domain.Entities.Simulation;
using PoMiniGames.Domain.Enums.Simulation;
using PoShared.Simulation.Models;

// GoF: Template Method — GenerateNarrative() selects and fills in a template based on outcome + winner DNA
public sealed class NarrativeService
{
    /// <summary>
    /// Generates a deterministic post-mortem narrative string based on the simulation outcome
    /// and the dominant DNA trait of the winning agents (if any).
    /// </summary>
    public string GenerateNarrative(
        SimulationOutcome outcome,
        string? winningTeam,
        IReadOnlyList<HeartbeatEventDto>? heartbeats,
        IReadOnlyList<AgentFinalSnapshotDto> agents)
    {
        return outcome switch
        {
            SimulationOutcome.Draw      => GenerateDraw(agents),
            SimulationOutcome.RedWin    => GenerateWin("RED", TeamColor.Red,  "Red",  agents, heartbeats),
            SimulationOutcome.BlueWin   => GenerateWin("BLUE", TeamColor.Blue, "Blue", agents, heartbeats),
            _                           => "SIMULATION TERMINATED. RECORDS INCOMPLETE.",
        };
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private static string GenerateDraw(IReadOnlyList<AgentFinalSnapshotDto> agents)
    {
        var total = agents.Sum(a => a.TotalDamageDealt);
        return
            $"MUTUAL ANNIHILATION CONFIRMED.\n\n" +
            $"Both factions achieved simultaneous elimination.\n" +
            $"Total damage exchanged: {total} units.\n" +
            $"No survivors. No victory. No peace.\n\n" +
            $"The grid is silent.";
    }

    private static string GenerateWin(
        string displayName,
        TeamColor team,
        string teamKey,
        IReadOnlyList<AgentFinalSnapshotDto> agents,
        IReadOnlyList<HeartbeatEventDto>? heartbeats)
    {
        var winners = agents.Where(a => a.Team == teamKey).ToList();
        var losers  = agents.Where(a => a.Team != teamKey).ToList();

        var topKiller  = winners.MaxBy(a => a.KillCount);
        var dominant   = topKiller is null ? "UNKNOWN" : GetDominantTrait(topKiller);
        var totalKills = winners.Sum(a => a.KillCount);
        var totalFood  = winners.Sum(a => a.FoodConsumed);
        var survTurns  = winners.Count > 0 ? winners.Max(a => a.SurvivalTurns) : 0;

        var traitNarrative = dominant switch
        {
            "Predatory"  => BuildPredatoryNarrative(displayName, topKiller!, totalKills),
            "Scavenger"  => BuildScavengerNarrative(displayName, topKiller!, totalFood),
            "Paranoid"   => BuildParanoidNarrative(displayName, topKiller!, survTurns),
            "Altruistic" => BuildAltruisticNarrative(displayName, topKiller!),
            "Methodical" => BuildMethodicalNarrative(displayName, topKiller!, totalKills, totalFood),
            _            => $"{displayName} FACTION PREVAILED through unfathomable strategy.",
        };

        var casualties = losers.Count;
        return
            $"VICTORY: {displayName} FACTION\n\n" +
            traitNarrative + "\n\n" +
            $"Enemy casualties: {casualties}.\n" +
            $"Total kills by {displayName}: {totalKills}. Food consumed: {totalFood}.";
    }

    private static string BuildPredatoryNarrative(string team, AgentFinalSnapshotDto top, int kills) =>
        $"The {team} faction fought with brutal efficiency.\n" +
        $"Agent {top.Id} led the assault — {top.KillCount} confirmed eliminations.\n" +
        $"Predatory drives dominated every engagement. {kills} total kills recorded.";

    private static string BuildScavengerNarrative(string team, AgentFinalSnapshotDto top, int food) =>
        $"The {team} faction outlasted its enemies through superior resource management.\n" +
        $"Agent {top.Id} consumed {top.FoodConsumed} food nodes — sustaining peak HP throughout.\n" +
        $"Hunger never became a factor. {food} total resources harvested.";

    private static string BuildParanoidNarrative(string team, AgentFinalSnapshotDto top, int turns) =>
        $"The {team} faction won through evasion and attrition.\n" +
        $"Agent {top.Id} survived {top.SurvivalTurns} turns, outlasting all opposition.\n" +
        $"Enemy overextension proved fatal. Maximum survival span: {turns} turns.";

    private static string BuildAltruisticNarrative(string team, AgentFinalSnapshotDto top) =>
        $"The {team} faction demonstrated extraordinary unit cohesion.\n" +
        $"Agent {top.Id} anchored the formation — holding position to protect team integrity.\n" +
        $"Coordinated positioning overwhelmed the disorganised enemy.";

    private static string BuildMethodicalNarrative(string team, AgentFinalSnapshotDto top, int kills, int food) =>
        $"The {team} faction executed a textbook campaign.\n" +
        $"Agent {top.Id} balanced aggression and foraging with precision.\n" +
        $"Kills: {kills}. Food consumed: {food}. The algorithm was never in doubt.";

    private static string GetDominantTrait(AgentFinalSnapshotDto a)
    {
        var traits = new (float W, string N)[]
        {
            (a.Predatory,  "Predatory"),
            (a.Scavenger,  "Scavenger"),
            (a.Paranoid,   "Paranoid"),
            (a.Altruistic, "Altruistic"),
            (a.Methodical, "Methodical"),
        };
        return traits.MaxBy(t => t.W).N;
    }
}
