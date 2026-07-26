namespace PoMiniGames.Features.PoSurvive.Endpoints;

using Microsoft.AspNetCore.Http.HttpResults;
using PoMiniGames.Application.Simulation;
using PoMiniGames.Domain.Entities.Simulation;
using PoMiniGames.Domain.Enums.Simulation;
using PoMiniGames.Domain.ValueObjects.Simulation;
using PoShared.Simulation.Models;

public static class SessionEndpoints
{
    public static IEndpointRouteBuilder MapSessionEndpoints(this IEndpointRouteBuilder routes)
    {
        // §1 NET_CLEAN_10: single-endpoint slices still use MapGroup so the
        // route prefix + OpenAPI tag + auth gate are declared once at the group
        // boundary (mirrors the convention in every other slice).
        var group = routes.MapGroup("/api/sessions").WithTags("PoSurvive");

        group.MapPost("", PostSessionAsync)
             .WithName("PostSession")
             .WithSummary("Persist a completed simulation session summary.")
             .Produces<SessionPersistedResponse>(StatusCodes.Status201Created)
             .ProducesValidationProblem()
             .ProducesProblem(StatusCodes.Status500InternalServerError);

        return routes;
    }

    // ─── Handler ─────────────────────────────────────────────────────────────

    private static async Task<IResult> PostSessionAsync(
        SessionSummaryDto dto,
        ISessionRepository repository,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        var logger = loggerFactory.CreateLogger("PoSurvive.Server.Endpoints.SessionEndpoints");
        // ── Input validation ──────────────────────────────────────────────
        if (dto.SessionId == Guid.Empty)
            return Results.ValidationProblem(
                new Dictionary<string, string[]> { ["sessionId"] = ["sessionId must not be empty."] });

        if (!Enum.TryParse<SimulationOutcome>(dto.Outcome, ignoreCase: true, out var outcome))
            return Results.ValidationProblem(
                new Dictionary<string, string[]>
                {
                    ["outcome"] = [$"'{dto.Outcome}' is not a valid outcome. Expected: RedWin, BlueWin, Draw."]
                });

        TeamColor? winningTeam = null;
        if (dto.WinningTeam is not null)
        {
            if (!Enum.TryParse<TeamColor>(dto.WinningTeam, ignoreCase: true, out var parsed))
                return Results.ValidationProblem(
                    new Dictionary<string, string[]>
                    {
                        ["winningTeam"] = [$"'{dto.WinningTeam}' is not a valid team. Expected: Red, Blue."]
                    });
            winningTeam = parsed;
        }

        if (outcome == SimulationOutcome.Draw && winningTeam is not null)
            return Results.ValidationProblem(
                new Dictionary<string, string[]>
                {
                    ["winningTeam"] = ["winningTeam must be null when outcome is Draw."]
                });

        if (dto.EndedAt <= dto.StartedAt)
            return Results.ValidationProblem(
                new Dictionary<string, string[]>
                {
                    ["endedAt"] = ["endedAt must be after startedAt."]
                });

        // ── Map DTO → domain aggregate ────────────────────────────────────
        var config = new SimulationConfigSnapshot(
            TeamSize: dto.Config.TeamSize,
            RockDensity: dto.Config.RockDensity,
            FoodSpawnChance: dto.Config.FoodSpawnChance,
            FoodTtl: dto.Config.FoodTtl,
            HungerDecayConstant: dto.Config.HungerDecayConstant,
            HungerThreshold: dto.Config.HungerThreshold,
            StarveHpLossPerTurn: dto.Config.StarveHpLossPerTurn,
            BaseDamage: dto.Config.BaseDamage,
            HeartbeatMinMs: dto.Config.HeartbeatMinMs,
            HeartbeatMaxMs: dto.Config.HeartbeatMaxMs,
            InferenceTimeoutMs: dto.Config.InferenceTimeoutMs,
            MaxInferredAgentsPerTurn: dto.Config.MaxInferredAgentsPerTurn
        );

        var session = new SimulationSession(dto.SessionId, config, dto.StartedAt)
        {
            EndedAt = (DateTimeOffset?)dto.EndedAt,
            Outcome = outcome,
            WinningTeam = winningTeam,
            TotalTurns = dto.TotalTurns,
            TotalFoodConsumed = dto.TotalFoodConsumed,
            TotalDamageDealt = dto.TotalDamageDealt,
            AgentSnapshots = dto.Agents
                .Select(a => new AgentFinalSnapshot(
                    Id: a.Id,
                    Team: Enum.Parse<TeamColor>(a.Team, ignoreCase: true),
                    Hp: a.Hp,
                    KillCount: a.KillCount,
                    FoodConsumed: a.FoodConsumed,
                    TotalDamageDealt: a.TotalDamageDealt,
                    Predatory: a.Predatory,
                    Scavenger: a.Scavenger,
                    Paranoid: a.Paranoid,
                    Altruistic: a.Altruistic,
                    Methodical: a.Methodical,
                    SurvivalTurns: a.SurvivalTurns))
                .ToList()
                .AsReadOnly(),
        };

        // ── Persist ───────────────────────────────────────────────────────
        try
        {
            await repository.SaveSessionAsync(session, ct);
            logger.LogInformation(
                "Session {SessionId} persisted. Outcome={Outcome} Turns={Turns}",
                session.SessionId, session.Outcome, session.TotalTurns);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to persist session {SessionId}", dto.SessionId);
            return Results.Problem(
                title: "Persistence failed",
                detail: "The session summary could not be saved. Please try again.",
                statusCode: StatusCodes.Status500InternalServerError);
        }

        return Results.Created(
            $"/api/sessions/{session.SessionId}",
            new SessionPersistedResponse(session.SessionId, Persisted: true));
    }

    private sealed record SessionPersistedResponse(Guid SessionId, bool Persisted);
}
