using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// The officials' radio lines and the post-race debrief (see <see cref="PoCabinetTalkService"/>).
/// Mapped on the authenticated <c>/api</c> group like every other game-data route.
/// </summary>
public static class PoCabinetTalkEndpoints
{
    public static IEndpointRouteBuilder MapPoCabinetTalkEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/pocabinet").WithTags("PoCabinet");

        // The client still sends ?track=; the scripted pool is the same on every track.
        group.MapGet("/banter", () => Results.Ok(PoCabinetTalkService.Banter()))
            .WithName("PoCabinetBanter")
            .WithSummary("The officials' scripted radio lines")
            .Produces<PoCabinetBanterPool>();

        group.MapPost("/debrief", (PoCabinetDebriefRequest request) => Results.Ok(PoCabinetTalkService.Debrief(request)))
            .WithName("PoCabinetDebrief")
            .WithSummary("A post-race headline and up to three driving tips from the race numbers")
            .Produces<PoCabinetDebriefReply>();
        return app;
    }
}
