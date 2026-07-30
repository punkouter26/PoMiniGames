namespace PoMiniGamesClient.Games.PoSurvive.Services;

using System.Net.Http.Json;
using PoMiniGamesClient.Services;
using PoShared.Simulation.Models;

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

// The RecordEvolutionRequest / AgentEvolutionResult records that used to sit here now live in
// PoShared (PoShared.Simulation.Models.EvolutionDtos) — one declaration shared with the
// server endpoint that consumes them, instead of two that merely happened to match.
