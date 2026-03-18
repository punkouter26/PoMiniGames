namespace PoMiniGames.Features.PoRaceRagdoll;

/// <summary>Minimal API endpoints for the PoRaceRagdoll game.</summary>
public static class GameEndpoints
{
    public static IEndpointRouteBuilder MapGameEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/game/session",
            (IGameSessionService sessions) =>
            {
                var sessionId = sessions.CreateSession();
                var state = sessions.GetSession(sessionId);
                return Results.Ok(new { sessionId, state });
            })
            .WithName("CreateGameSession")
            .WithTags("PoRaceRagdoll")
            .WithSummary("Create a new PoRaceRagdoll game session");

        app.MapGet("/api/game/session/{sessionId}",
            (string sessionId, IGameSessionService sessions) =>
            {
                var state = sessions.GetSession(sessionId);
                return state is null
                    ? Results.NotFound(new { error = "Session not found" })
                    : Results.Ok(state);
            })
            .WithName("GetGameSession")
            .WithTags("PoRaceRagdoll")
            .WithSummary("Get an existing PoRaceRagdoll game session");

        app.MapPost("/api/game/session/{sessionId}/bet",
            (string sessionId, PlaceBetRequest request, IGameSessionService sessions) =>
            {
                if (request.RacerId < 0)
                    return Results.BadRequest(new { error = "Invalid racer ID" });

                var (state, outcome) = sessions.PlaceBet(sessionId, request.RacerId);

                return outcome switch
                {
                    PlaceBetOutcome.NotFound       => Results.NotFound(new { error = "Session not found" }),
                    PlaceBetOutcome.WrongPhase     => Results.Conflict(new { error = "A bet has already been placed for this round." }),
                    PlaceBetOutcome.InsufficientBalance => Results.BadRequest(new { error = "Insufficient balance." }),
                    PlaceBetOutcome.InvalidRacer   => Results.BadRequest(new { error = "Invalid racer ID." }),
                    _                              => Results.Ok(state),
                };
            })
            .WithName("PlaceBet")
            .WithTags("PoRaceRagdoll")
            .WithSummary("Place a bet on a racer in a PoRaceRagdoll session");

        app.MapPost("/api/game/session/{sessionId}/finish",
            (string sessionId, IGameSessionService sessions) =>
            {
                var (state, result) = sessions.FinishRace(sessionId);

                return state is null
                    ? Results.NotFound(new { error = "Session not found" })
                    : Results.Ok(new { state, result });
            })
            .WithName("FinishRace")
            .WithTags("PoRaceRagdoll")
            .WithSummary("Finish a race and record the server-determined winner");

        app.MapPost("/api/game/session/{sessionId}/next",
            (string sessionId, IGameSessionService sessions) =>
            {
                var state = sessions.NextRound(sessionId);
                return state is null
                    ? Results.NotFound(new { error = "Session not found" })
                    : Results.Ok(state);
            })
            .WithName("NextRound")
            .WithTags("PoRaceRagdoll")
            .WithSummary("Advance to the next round in a PoRaceRagdoll session");

        app.MapGet("/api/game/species",
            (IRacerService racers) => Results.Ok(racers.GetAvailableSpecies()))
            .WithName("GetSpecies")
            .WithTags("PoRaceRagdoll")
            .WithSummary("Get all available racer species");

        return app;
    }
}
