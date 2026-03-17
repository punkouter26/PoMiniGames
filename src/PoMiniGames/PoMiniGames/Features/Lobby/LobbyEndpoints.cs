namespace PoMiniGames.Features.Lobby;

public static class LobbyEndpoints
{
    public static IEndpointRouteBuilder MapLobbyEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/lobby", (ILobbyService lobbyService) =>
            Results.Ok(lobbyService.GetSnapshot()))
            .WithName("GetLobbySnapshot")
            .WithTags("Lobby")
            .WithSummary("Returns the current lobby state (players waiting, host).");

        return app;
    }
}

