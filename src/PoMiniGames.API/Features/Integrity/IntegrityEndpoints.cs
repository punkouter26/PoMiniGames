using Microsoft.Extensions.Options;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Features.Integrity;

/// <summary>What the client needs to know to decide whether to bother minting sessions.</summary>
public sealed record IntegrityStatusDto(string Mode, int SessionTtlMinutes, bool EnforcesValueBounds, bool ModeratesDisplayNames);

/// <summary>
/// Endpoints for the score-integrity slice: mint a play session, and report the guard's posture.
/// Endpoints for the score-integrity slice: mint a play session.
/// </summary>
/// <remarks>
/// The mint endpoint sits in the authenticated group (see EndpointRouteExtensions) because a
/// session is bound to an identity and there is nothing to bind for an anonymous caller. Status
/// is anonymous — it reports configuration, not data, and the client reads it before sign-in to
/// decide whether to run the session machinery at all.
/// session is bound to an identity and there is nothing to bind for an anonymous caller.
/// </remarks>
public static class IntegrityEndpoints
{
    /// <summary>Mint: authenticated, because the session is identity-bound.</summary>
    public static IEndpointRouteBuilder MapPlaySessionEndpoints(this IEndpointRouteBuilder app)
    {
        // §1 MapGroup() per slice: play sessions share /api/play.
        var play = app.MapGroup("/play").WithTags("Integrity");

        play.MapPost("/sessions/{game}",
            (string game, HttpContext http, IPlaySessionService sessions, IOptionsMonitor<IntegrityOptions> options) =>
            {
                if (options.CurrentValue.Mode == IntegrityMode.Off)
                {
                    // Nothing to mint, and saying so lets the client stop asking rather than
                    // retrying a 404 on every navigation.
                    return Results.NoContent();
                }

                // §8 allow-list: only the well-known catalogue may hold a session, so a typo'd
                // key fails here rather than minting a token that can never be redeemed.
                if (GameKey.TryParse(game) is not { } key)
                {
                    return Results.BadRequest(new { error = $"Unknown game key '{game}'" });
                }

                var identity = RequestIdentity.Resolve(http.User);
                var identityKey = !string.IsNullOrEmpty(identity.UserId) ? identity.UserId
                    : !string.IsNullOrWhiteSpace(identity.DisplayName) ? identity.DisplayName
                    : "anon";

                return Results.Ok(sessions.Issue(key, identityKey));
            })
            .WithName("StartPlaySession")
            .WithSummary("Mint a signed play session for a game, redeemable on score submission")
            .Produces<PlaySessionTicket>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .RequireRateLimiting("play-session");

        return app;
    }

    /// <summary>Status: anonymous configuration read, mapped with the other public endpoints.</summary>
    public static IEndpointRouteBuilder MapIntegrityStatusEndpoint(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/play/status",
            (IOptionsMonitor<IntegrityOptions> options) =>
            {
                var current = options.CurrentValue;
                return Results.Ok(new IntegrityStatusDto(
                    current.Mode.ToString(),
                    current.SessionTtlMinutes,
                    current.EnforceValueBounds,
                    current.ModerateDisplayNames));
            })
            .WithTags("Integrity")
            .WithName("GetIntegrityStatus")
            .WithSummary("Report the score-integrity posture this deployment is running")
            .Produces<IntegrityStatusDto>(StatusCodes.Status200OK);

        return app;
    }
}
