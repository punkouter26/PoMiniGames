using PoMiniGames.Features.Auth;

namespace PoMiniGames.Features.MatchHistory;

/// <summary>
/// Minimal API endpoints for recording and reading head-to-head match results.
/// The owner identity is server-authoritative for signed-in callers (forced to the
/// claim identity so nobody can read or forge another user's record); truly-anonymous
/// guests fall back to the client-supplied name, which is inherently low-trust.
/// </summary>
public static class MatchHistoryEndpoints
{
    public static IEndpointRouteBuilder MapMatchHistoryEndpoints(this IEndpointRouteBuilder app)
    {
        // §1 MapGroup() per slice: match history POST + GET share /api/matches.
        var matches = app.MapGroup("/api/matches").WithTags("MatchHistory");

        matches.MapPost("",
            async (MatchRecordRequest request, HttpContext http, MatchHistoryRepository repo) =>
            {
                if (string.IsNullOrWhiteSpace(request.Game))
                    return Results.BadRequest(new { error = "Game is required" });
                if (string.IsNullOrWhiteSpace(request.OpponentName))
                    return Results.BadRequest(new { error = "OpponentName is required" });

                // §1: a signed-in caller may only write to their OWN partition — the client
                // Owner is overridden with the claim identity. Guests keep the supplied name.
                var identity = RequestIdentity.Resolve(http.User);
                var owner = identity.IsAuthenticated && !string.IsNullOrWhiteSpace(identity.DisplayName)
                    ? identity.DisplayName
                    : request.Owner;
                if (string.IsNullOrWhiteSpace(owner))
                    return Results.BadRequest(new { error = "Owner is required" });

                await repo.RecordAsync(request with { Owner = owner });
                return Results.Created("/api/matches", null);
            })
            .WithName("RecordMatch")
            .WithSummary("Record a finished head-to-head match result")
            .Produces(StatusCodes.Status201Created)
            .RequireRateLimiting("highscores");

        matches.MapGet("",
            async (HttpContext http, MatchHistoryRepository repo, string? owner = null, int limit = 500) =>
            {
                // §1: a signed-in caller can only read their OWN history — the owner query
                // param is ignored and forced to the claim identity (closes the IDOR read).
                var identity = RequestIdentity.Resolve(http.User);
                var effectiveOwner = identity.IsAuthenticated && !string.IsNullOrWhiteSpace(identity.DisplayName)
                    ? identity.DisplayName
                    : owner;
                if (string.IsNullOrWhiteSpace(effectiveOwner))
                    return Results.BadRequest(new { error = "owner query parameter is required" });

                var records = await repo.GetForOwnerAsync(effectiveOwner, limit);
                return Results.Ok(records);
            })
            .WithName("GetMatches")
            .WithSummary("Read the caller's match history, most recent first")
            .Produces<IEnumerable<MatchRecordDto>>(StatusCodes.Status200OK);

        return app;
    }
}
