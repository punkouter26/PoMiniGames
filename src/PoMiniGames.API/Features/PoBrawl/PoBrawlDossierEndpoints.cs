using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl;

/// <summary>
/// <c>GET /api/pobrawl/dossier</c>: every fighter's dossier card in one call. Anonymous, like the
/// leaderboard reads — it is public reference text, and the fighter select is browsable before
/// sign-in. Always 200: Wikipedia trouble degrades to the static facts.
/// </summary>
public static class PoBrawlDossierEndpoints
{
    public static IEndpointRouteBuilder MapPoBrawlDossierEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/pobrawl/dossier",
            async (PoBrawlDossierService dossiers, HttpContext http, CancellationToken cancellationToken) =>
            {
                // The list changes at most daily; let the browser and the PWA reuse it for an hour.
                http.Response.Headers.CacheControl = "public, max-age=3600";
                return Results.Ok(await dossiers.GetAllAsync(cancellationToken));
            })
            .WithTags("PoBrawl")
            .WithName("GetPoBrawlDossiers")
            .WithSummary("PoBrawl fighter dossiers (static facts + Wikipedia summary)")
            .Produces<IReadOnlyList<PoBrawlDossierDto>>(StatusCodes.Status200OK)
            .AllowAnonymous();

        return app;
    }
}
