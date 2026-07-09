namespace PoMiniGames.Features.PoSurvive.Endpoints;

using Microsoft.AspNetCore.Mvc;
using PoMiniGames.Application.Simulation;
using PoMiniGames.Domain.ValueObjects.Simulation;
using PoShared.Simulation.Models;

/// <summary>
/// API endpoints for LLM-Powered Agent Evolution.
/// POST /api/evolution/record — record session outcomes
/// GET  /api/evolution/states — list all evolution states
/// GET  /api/evolution/summary — get evolution summary stats
/// GET  /api/evolution/tree — get evolution tree for visualization
/// POST /api/evolution/evolve — trigger manual evolution from a parent
/// POST /api/evolution/crossover — trigger crossover between two parents
/// POST /api/evolution/seed — seed initial DNA pool
/// DELETE /api/evolution/reset — reset all evolution data
/// </summary>
public static class EvolutionEndpoints
{
    public static IEndpointRouteBuilder MapEvolutionEndpoints(this IEndpointRouteBuilder routes)
    {
        var group = routes.MapGroup("/api/evolution");

        group.MapPost("/record", RecordSessionOutcomeAsync)
             .WithName("EvolutionRecord")
             .WithSummary("Record session outcome for evolution tracking.");

        group.MapGet("/states", GetAllStatesAsync)
             .WithName("EvolutionStates")
             .WithSummary("Get all evolution states.");

        group.MapGet("/summary", GetSummaryAsync)
             .WithName("EvolutionSummary")
             .WithSummary("Get evolution summary dashboard stats.");

        group.MapGet("/tree", GetTreeAsync)
             .WithName("EvolutionTree")
             .WithSummary("Get evolution tree for visualization.");

        group.MapPost("/evolve", EvolveDnaAsync)
             .WithName("EvolutionEvolve")
             .WithSummary("Evolve a new DNA from a parent.");

        group.MapPost("/crossover", CrossoverDnaAsync)
             .WithName("EvolutionCrossover")
             .WithSummary("Crossover two parent DNAs to produce a child.");

        group.MapPost("/seed", SeedAsync)
             .WithName("EvolutionSeed")
             .WithSummary("Seed initial DNA pool.");

        group.MapDelete("/reset", ResetAsync)
             .WithName("EvolutionReset")
             .WithSummary("Reset all evolution data.");

        return routes;
    }

    private static async Task<IResult> RecordSessionOutcomeAsync(
        [FromBody] RecordEvolutionRequest request,
        EvolutionEngine engine,
        CancellationToken ct)
    {
        if (request.Agents.Count == 0)
            return Results.Ok(); // Nothing to record

        var agentResults = request.Agents.Select(a =>
        {
            var dna = new PersonalityDna(
                a.Predatory, a.Scavenger, a.Paranoid, a.Altruistic, a.Methodical);
            return (Dna: dna, a.AgentId, a.Team, a.IsWinner,
                    a.KillCount, a.FoodConsumed, a.DamageDealt);
        }).ToList();

        await engine.RecordSessionOutcomeAsync(agentResults, request.SessionId, ct);
        return Results.Ok(new { recorded = agentResults.Count });
    }

    private static async Task<IResult> GetAllStatesAsync(
        EvolutionEngine engine,
        CancellationToken ct)
    {
        var states = await engine.GetAllStatesAsync(ct);
        return Results.Ok(states);
    }

    private static async Task<IResult> GetSummaryAsync(
        EvolutionEngine engine,
        CancellationToken ct)
    {
        var summary = await engine.GetSummaryAsync(ct);
        return Results.Ok(summary);
    }

    private static async Task<IResult> GetTreeAsync(
        EvolutionEngine engine,
        CancellationToken ct)
    {
        var tree = await engine.BuildEvolutionTreeAsync(ct);
        return Results.Ok(tree);
    }

    private static async Task<IResult> EvolveDnaAsync(
        [FromBody] EvolutionRequestDto request,
        EvolutionEngine engine,
        CancellationToken ct)
    {
        // Build parent DNA from the request
        // Parse DNA ID back into components (DNA-P-Sc-Pa-A-M format)
        var parts = request.ParentDnaId.Split('-');
        if (parts.Length != 6 || parts[0] != "DNA")
            return Results.BadRequest("Invalid DNA ID format. Expected: DNA-P-Sc-Pa-A-M");

        if (!float.TryParse(parts[1], out var predatory) ||
            !float.TryParse(parts[2], out var scavenger) ||
            !float.TryParse(parts[3], out var paranoid) ||
            !float.TryParse(parts[4], out var altruistic) ||
            !float.TryParse(parts[5], out var methodical))
            return Results.BadRequest("Invalid DNA trait values in ID.");

        var parentDna = new PersonalityDna(predatory, scavenger, paranoid, altruistic, methodical);
        var child = await engine.EvolveDnaAsync(parentDna, request.StrategyPrompt, ct);

        return Results.Ok(MapToDto(child));
    }

    private static async Task<IResult> CrossoverDnaAsync(
        [FromBody] CrossoverRequest request,
        EvolutionEngine engine,
        CancellationToken ct)
    {
        PersonalityDna ParseDnaId(string dnaId)
        {
            var parts = dnaId.Split('-');
            if (parts.Length != 6 || parts[0] != "DNA")
                throw new ArgumentException("Invalid DNA ID");
            return new PersonalityDna(
                float.Parse(parts[1]), float.Parse(parts[2]),
                float.Parse(parts[3]), float.Parse(parts[4]),
                float.Parse(parts[5]));
        }

        try
        {
            var parent1 = ParseDnaId(request.Parent1DnaId);
            var parent2 = ParseDnaId(request.Parent2DnaId);
            var child = await engine.CrossoverDnaAsync(parent1, parent2, ct);
            return Results.Ok(MapToDto(child));
        }
        catch (Exception ex)
        {
            return Results.BadRequest($"Invalid DNA ID: {ex.Message}");
        }
    }

    private static async Task<IResult> SeedAsync(
        [FromQuery] int count,
        EvolutionEngine engine,
        CancellationToken ct)
    {
        var c = count > 0 ? count : 8;
        await engine.SeedInitialDnaAsync(c, ct);
        return Results.Ok(new { seeded = c });
    }

    private static async Task<IResult> ResetAsync(
        EvolutionEngine engine,
        CancellationToken ct)
    {
        await engine.ResetAsync(ct);
        return Results.Ok(new { reset = true });
    }

    // ─── Private helpers ──────────────────────────────────────────────────

    private static EvolutionStateDto MapToDto(PersonalityDna dna)
    {
        return new EvolutionStateDto(
            Id:                dna.GetDnaId(),
            DnaId:             dna.GetDnaId(),
            Predatory:         dna.Predatory,
            Scavenger:         dna.Scavenger,
            Paranoid:          dna.Paranoid,
            Altruistic:        dna.Altruistic,
            Methodical:        dna.Methodical,
            Generation:        dna.Generation,
            SourceSessionId:   dna.SourceSessionId,
            ParentDnaIds:      dna.ParentDnaIds.ToList(),
            Archetype:         dna.Archetype,
            DominantTrait:     dna.DominantTrait,
            CreatedAt:         dna.CreatedAt,
            WinCount:          dna.WinCount,
            TotalSessions:     dna.TotalSessions,
            WinRate:           dna.WinRate,
            TotalKills:        0,
            TotalFoodConsumed: 0,
            TotalDamageDealt:  0
        );
    }

    /// <summary>Request body for recording evolution outcomes.</summary>
    public sealed record RecordEvolutionRequest(
        string SessionId,
        List<AgentEvolutionResult> Agents
    );

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

    public sealed record CrossoverRequest(
        string Parent1DnaId,
        string Parent2DnaId
    );
}