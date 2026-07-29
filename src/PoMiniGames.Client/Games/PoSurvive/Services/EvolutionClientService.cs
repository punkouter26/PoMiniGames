namespace PoMiniGamesClient.Games.PoSurvive.Services;

using System.Net.Http.Json;
using PoMiniGamesClient.Services;

/// <summary>
/// Client-side service that calls the server evolution API.
/// Used by SimulationOrchestrator to record session outcomes.
///
/// The query/admin methods (states, summary, tree, evolve, crossover, seed, reset) were
/// removed together with the EvolutionLab component that was their only caller and had
/// no route to reach it. Their server endpoints are gone too.
/// </summary>
public sealed class EvolutionClientService
{
    private readonly HttpClient _http;

    public EvolutionClientService(HttpClient http)
    {
        _http = http;
    }

    /// <summary>Record a session's agent outcomes for evolution tracking.</summary>
    public async Task RecordSessionOutcomeAsync(
        RecordEvolutionRequest request,
        CancellationToken ct = default)
    {
        try
        {
            var response = await _http.PostAsJsonAsync("/api/evolution/record", request, ApiJsonContext.Default.RecordEvolutionRequest, ct);
            response.EnsureSuccessStatusCode();
        }
        catch
        {
            // Swallow — evolution recording is best-effort; don't block session flow
        }
    }
}

/// <summary>Request body for recording evolution outcomes.</summary>
public sealed record RecordEvolutionRequest(
    string SessionId,
    List<AgentEvolutionResult> Agents
);

/// <summary>Per-agent evolution result.</summary>
public sealed record AgentEvolutionResult(
    float Predatory,
    float Scavenger,
    float Paranoid,
    float Altruistic,
    float Methodical,
    string AgentId,
    string Team,
    bool IsWinner,
    int KillCount,
    int FoodConsumed,
    int DamageDealt
);
