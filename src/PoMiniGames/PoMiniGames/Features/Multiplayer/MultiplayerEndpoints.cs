using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Features.Multiplayer;

public static class MultiplayerEndpoints
{
    public static IEndpointRouteBuilder MapMultiplayerEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/multiplayer/games", (IMultiplayerGameRegistry registry) => Results.Ok(registry.GetSupportedGames()))
            .WithName("GetSupportedMultiplayerGames")
            .WithTags("Multiplayer")
            .WithSummary("Returns the games currently available for online multiplayer.");

        app.MapGet("/api/multiplayer/matches/active", [Authorize] (
            IMultiplayerService service) =>
        {
            var matches = service.GetActiveMatches();
            return Results.Ok(matches);
        })
        .WithName("GetActiveMultiplayerMatches")
        .WithTags("Multiplayer")
        .WithSummary("Returns all active multiplayer matches (for spectator listing).");

        app.MapPost("/api/multiplayer/queue", [Authorize] async (
            QueueMatchRequest request,
            HttpContext context,
            IMultiplayerService service,
            IMultiplayerGameRegistry registry,
            IHubContext<MultiplayerHub> hubContext) =>
        {
            if (string.IsNullOrWhiteSpace(request.GameKey))
            {
                return Results.BadRequest(new { error = "Game key is required." });
            }

            if (!AuthenticatedUser.TryCreate(context.User, out var user) || user is null)
            {
                return Results.Unauthorized();
            }

            if (!registry.TryGetAdapter(request.GameKey, out _))
            {
                return Results.BadRequest(new { error = $"Unsupported multiplayer game '{request.GameKey}'." });
            }

            var snapshot = service.JoinQueue(request.GameKey, user);
            await BroadcastSnapshotAsync(hubContext, snapshot);
            return Results.Ok(snapshot);
        })
        .WithName("JoinMultiplayerQueue")
        .WithTags("Multiplayer")
        .WithSummary("Joins or creates a public matchmaking slot for a multiplayer game.");

        app.MapGet("/api/multiplayer/matches/{matchId}", [Authorize] (
            string matchId,
            HttpContext context,
            IMultiplayerService service) =>
        {
            if (!AuthenticatedUser.TryCreate(context.User, out var user) || user is null)
            {
                return Results.Unauthorized();
            }

            var snapshot = service.GetMatch(matchId, user);
            return snapshot is null
                ? Results.NotFound(new { error = "Match not found." })
                : Results.Ok(snapshot);
        })
        .WithName("GetMultiplayerMatch")
        .WithTags("Multiplayer")
        .WithSummary("Returns the latest state for a multiplayer match.");

        app.MapDelete("/api/multiplayer/matches/{matchId}", [Authorize] async (
            string matchId,
            HttpContext context,
            IMultiplayerService service,
            IHubContext<MultiplayerHub> hubContext) =>
        {
            if (!AuthenticatedUser.TryCreate(context.User, out var user) || user is null)
            {
                return Results.Unauthorized();
            }

            var snapshot = service.LeaveMatch(matchId, user);
            if (snapshot is null)
            {
                return Results.NotFound(new { error = "Match not found." });
            }

            await BroadcastSnapshotAsync(hubContext, snapshot);
            return Results.Ok(snapshot);
        })
        .WithName("LeaveMultiplayerMatch")
        .WithTags("Multiplayer")
        .WithSummary("Leaves the current matchmaking slot or active multiplayer match.");

        app.MapPost("/api/multiplayer/matches/{matchId}/turn", [Authorize] async (
            string matchId,
            MatchActionRequest request,
            HttpContext context,
            IMultiplayerService service,
            IHubContext<MultiplayerHub> hubContext) =>
        {
            if (!AuthenticatedUser.TryCreate(context.User, out var user) || user is null)
            {
                return Results.Unauthorized();
            }

            var result = service.SubmitTurn(matchId, user, request.Action);
            if (result.NotFound)
            {
                return Results.NotFound(new { error = result.Error ?? "Match not found." });
            }

            if (!result.Accepted || result.Snapshot is null)
            {
                return Results.BadRequest(new { error = result.Error ?? "Turn could not be applied." });
            }

            await BroadcastSnapshotAsync(hubContext, result.Snapshot);
            return Results.Ok(result.Snapshot);
        })
        .WithName("SubmitTurnBasedAction")
        .WithTags("Multiplayer")
        .WithSummary("Submits a turn-based action for an authenticated multiplayer match.");

        return app;
    }

    internal static Task BroadcastSnapshotAsync(IHubContext<MultiplayerHub> hubContext, MultiplayerMatchSnapshot snapshot)
    {
        var userIds = snapshot.Participants
            .Select(participant => participant.UserId)
            .Distinct(StringComparer.Ordinal)
            .ToArray();

        if (userIds.Length == 0)
        {
            return Task.CompletedTask;
        }

        return hubContext.Clients.Users(userIds).SendAsync("MatchUpdated", snapshot);
    }
}
