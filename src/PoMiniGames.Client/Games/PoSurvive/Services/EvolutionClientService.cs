namespace PoSurvive.Client.Services;

using System.Net.Http.Json;
using PoMiniGamesClient.Services;
using PoSurvive.Shared.Models;

/// <summary>
/// Client-side service that calls the server evolution API endpoints.
/// Used by SimulationOrchestrator to record session outcomes and by
/// EvolutionLab UI to query evolution state.
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

    /// <summary>Get all evolution states.</summary>
    public async Task<IReadOnlyList<EvolutionStateDto>> GetAllStatesAsync(CancellationToken ct = default)
    {
        try
        {
            return await _http.GetFromJsonAsync(
                "/api/evolution/states", ApiJsonContext.Default.ListEvolutionStateDto, ct) ?? [];
        }
        catch { return []; }
    }

    /// <summary>Get evolution summary stats.</summary>
    public async Task<EvolutionSummaryDto?> GetSummaryAsync(CancellationToken ct = default)
    {
        try
        {
            return await _http.GetFromJsonAsync(
                "/api/evolution/summary", ApiJsonContext.Default.EvolutionSummaryDto, ct);
        }
        catch { return null; }
    }

    /// <summary>Get evolution tree for visualization.</summary>
    public async Task<EvolutionTreeDto?> GetTreeAsync(CancellationToken ct = default)
    {
        try
        {
            return await _http.GetFromJsonAsync(
                "/api/evolution/tree", ApiJsonContext.Default.EvolutionTreeDto, ct);
        }
        catch { return null; }
    }

    /// <summary>Trigger a manual evolution step from a parent DNA.</summary>
    public async Task<EvolutionStateDto?> EvolveAsync(
        string parentDnaId,
        string? strategyPrompt = null,
        CancellationToken ct = default)
    {
        try
        {
            var response = await _http.PostAsJsonAsync("/api/evolution/evolve",
                new EvolutionRequestDto(parentDnaId, strategyPrompt), ApiJsonContext.Default.EvolutionRequestDto, ct);
            response.EnsureSuccessStatusCode();
            return await response.Content.ReadFromJsonAsync(
                ApiJsonContext.Default.EvolutionStateDto, cancellationToken: ct);
        }
        catch { return null; }
    }

    /// <summary>Trigger a crossover between two parent DNAs.</summary>
    public async Task<EvolutionStateDto?> CrossoverAsync(
        string parent1DnaId,
        string parent2DnaId,
        CancellationToken ct = default)
    {
        try
        {
            var response = await _http.PostAsJsonAsync("/api/evolution/crossover",
                new CrossoverRequestDto(parent1DnaId, parent2DnaId), ApiJsonContext.Default.CrossoverRequestDto, ct);
            response.EnsureSuccessStatusCode();
            return await response.Content.ReadFromJsonAsync(
                ApiJsonContext.Default.EvolutionStateDto, cancellationToken: ct);
        }
        catch { return null; }
    }

    /// <summary>Seed initial DNA pool.</summary>
    public async Task SeedAsync(int count = 8, CancellationToken ct = default)
    {
        try
        {
            await _http.PostAsync($"/api/evolution/seed?count={count}", null, ct);
        }
        catch { }
    }

    /// <summary>Reset all evolution data.</summary>
    public async Task ResetAsync(CancellationToken ct = default)
    {
        try
        {
            await _http.DeleteAsync("/api/evolution/reset", ct);
        }
        catch { }
    }
}

/// <summary>Request body for crossover between two parent DNAs.</summary>
public sealed record CrossoverRequestDto(string Parent1DnaId, string Parent2DnaId);

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