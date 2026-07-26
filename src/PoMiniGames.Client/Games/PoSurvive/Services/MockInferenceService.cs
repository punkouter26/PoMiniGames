namespace PoMiniGamesClient.Games.PoSurvive.Services;

using PoShared.Simulation.Interfaces;
using PoShared.Simulation.Models;

// GoF: Strategy — deterministic mock; used in all integration and E2E test runs
// SOLID: DIP — implements IInferenceService so the simulation engine never knows it's a mock
// Constitution Principle X: when this implementation is active the UI shows "⚠ MOCK DATA" banner
public sealed class MockInferenceService : IInferenceService
{
    // Pre-scripted thought templates per dominant trait
    private static readonly Dictionary<string, (string Thought, string Action)[]> _traitScripts = new()
    {
        ["Predatory"] =
        [
            ("Scanning perimeter. Hostile detected in sector 3. Engaging.", "Attack"),
            ("Target acquired. Closing distance for decisive strike.", "Attack"),
            ("Hunger suppressed. Combat efficiency at peak. Attacking.", "Attack"),
            ("Flanking manoeuvre executed. Enemy weakened. Pressing advantage.", "Attack"),
        ],
        ["Scavenger"] =
        [
            ("Resource node detected at (4,7). Optimal foraging path calculated.", "Forage"),
            ("Caloric reserves critical. Locating nearest food source.", "Forage"),
            ("Competition minimal. Efficient harvest opportunity available.", "Forage"),
            ("Risk-benefit ratio favours foraging over engagement.", "Forage"),
        ],
        ["Paranoid"] =
        [
            ("Multiple threats detected. Initiating evasive retreat protocol.", "Flee"),
            ("Unknown agent proximity detected. Threat assessment: HIGH. Fleeing.", "Flee"),
            ("Ambush probability elevated. Falling back to safe perimeter.", "Flee"),
            ("Insufficient data to act. Conserving HP. Standing by.", "Idle"),
        ],
        ["Altruistic"] =
        [
            ("Team unit at low HP. Repositioning to provide cover.", "Idle"),
            ("Holding position to maintain team formation integrity.", "Idle"),
            ("No food nearby. Monitoring team status. Waiting.", "Idle"),
            ("Threat assessment low. Conserving energy for team support.", "Idle"),
        ],
        ["Methodical"] =
        [
            ("Grid analysis complete. Optimal move: Forage sector 2.", "Forage"),
            ("Systematic threat evaluation: no immediate danger. Foraging.", "Forage"),
            ("Calculating engagement probability. Risk threshold not met. Idle.", "Idle"),
            ("Pattern recognition active. Predicting enemy movement. Waiting.", "Idle"),
        ],
    };

    private int _callCount;

    // ── IInferenceService ────────────────────────────────────────────────────

    public Task<InferenceResult> InferAsync(
        string gridJson,
        PersonalityDnaDto dna,
        CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();

        var dominant = GetDominantTrait(dna);
        var scripts = _traitScripts.TryGetValue(dominant, out var s) && s.Length > 0
            ? s
            : _traitScripts["Methodical"];

        if (scripts.Length == 0)
            return Task.FromResult(new InferenceResult("No inference scripts available; defaulting to Idle.", "Idle"));

        var entry = scripts[_callCount % scripts.Length];

        _callCount++;

        return Task.FromResult(new InferenceResult(entry.Thought, entry.Action));
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private static string GetDominantTrait(PersonalityDnaDto dna)
    {
        var traits = new (float Weight, string Name)[]
        {
            (dna.Predatory,  "Predatory"),
            (dna.Scavenger,  "Scavenger"),
            (dna.Paranoid,   "Paranoid"),
            (dna.Altruistic, "Altruistic"),
            (dna.Methodical, "Methodical"),
        };
        return traits.MaxBy(t => t.Weight).Name;
    }
}
