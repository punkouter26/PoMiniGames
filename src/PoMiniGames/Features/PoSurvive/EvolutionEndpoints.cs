namespace PoMiniGames.Features.PoSurvive;

using Microsoft.AspNetCore.Mvc;
using PoMiniGames.Application.Simulation;
using PoMiniGames.Domain.ValueObjects.Simulation;
using PoShared.Simulation.Models;

/// <summary>
/// API endpoints for LLM-Powered Agent Evolution.
/// POST /api/evolution/record — record session outcomes.
///
/// The read/admin surface (states, summary, tree, evolve, crossover, seed, reset) was
/// removed: its only consumer was the EvolutionLab component, which had no route and was
/// never rendered. /seed and /reset in particular mutated the GLOBAL cross-user DNA pool
/// from the ordinary authenticated game API. Reinstate behind an admin policy if a real
/// evolution UI ever ships.
/// </summary>
public static class EvolutionEndpoints
{
    public static IEndpointRouteBuilder MapEvolutionEndpoints(this IEndpointRouteBuilder routes)
    {
        // §1 NET_CLEAN_10: route prefix + OpenAPI tag + rate limit are declared once at
        // the group boundary, matching every other slice. Auth comes from the parent
        // `gameApi` group in EndpointRouteExtensions.
        var group = routes.MapGroup("/api/evolution").WithTags("PoSurvive");

        group.MapPost("/record", RecordSessionOutcomeAsync)
             .WithName("EvolutionRecord")
             .WithSummary("Record session outcome for evolution tracking.")
             .RequireRateLimiting("highscores")
             .Produces(StatusCodes.Status200OK);

        return routes;
    }

    private static async Task<IResult> RecordSessionOutcomeAsync(
        [FromBody] RecordEvolutionRequest request,
        EvolutionEngine engine,
        CancellationToken ct)
    {
        if (request.Agents.Count == 0)
            return Results.Ok(new { recorded = 0 });

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

    // RecordEvolutionRequest / AgentEvolutionResult are no longer redeclared here: both are
    // PoShared.Simulation.Models types now, shared with the client that posts them.
}
