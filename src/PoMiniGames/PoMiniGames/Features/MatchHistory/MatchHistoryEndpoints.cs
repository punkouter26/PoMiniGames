namespace PoMiniGames.Features.MatchHistory;

/// <summary>
/// Minimal API endpoints for recording and reading head-to-head match results.
/// The owner identity is supplied by the client (MS-OAuth email when signed in,
/// otherwise the guest name) so both authenticated and guest players accumulate
/// a personal opponent record.
/// </summary>
public static class MatchHistoryEndpoints
{
    public static IEndpointRouteBuilder MapMatchHistoryEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/matches",
            async (MatchRecordRequest request, MatchHistoryRepository repo) =>
            {
                if (string.IsNullOrWhiteSpace(request.Owner))
                    return Results.BadRequest(new { error = "Owner is required" });
                if (string.IsNullOrWhiteSpace(request.Game))
                    return Results.BadRequest(new { error = "Game is required" });
                if (string.IsNullOrWhiteSpace(request.OpponentName))
                    return Results.BadRequest(new { error = "OpponentName is required" });

                await repo.RecordAsync(request);
                return Results.Created("/api/matches", null);
            })
            .WithName("RecordMatch")
            .WithTags("MatchHistory")
            .WithSummary("Record a finished head-to-head match result")
            .Produces(StatusCodes.Status201Created)
            .RequireRateLimiting("highscores");

        app.MapGet("/api/matches",
            async (string owner, MatchHistoryRepository repo, int limit = 500) =>
            {
                if (string.IsNullOrWhiteSpace(owner))
                    return Results.BadRequest(new { error = "owner query parameter is required" });

                var records = await repo.GetForOwnerAsync(owner, limit);
                return Results.Ok(records);
            })
            .WithName("GetMatches")
            .WithTags("MatchHistory")
            .WithSummary("Read an owner's match history, most recent first")
            .Produces<IEnumerable<MatchRecordDto>>(StatusCodes.Status200OK);

        return app;
    }
}
