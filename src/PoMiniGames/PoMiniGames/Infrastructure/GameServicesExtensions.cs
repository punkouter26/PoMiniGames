using PoMiniGames.Features.Lobby;
using PoMiniGames.Features.Multiplayer;
using PoMiniGames.Features.PoRaceRagdoll;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Registers all game-specific services: PoRaceRagdoll, SignalR multiplayer, and the Lobby.
/// </summary>
internal static class GameServicesExtensions
{
    public static IServiceCollection AddPoMiniGamesGameServices(this IServiceCollection services)
    {
        // PoRaceRagdoll
        services.AddSingleton<IOddsService, OddsService>();
        services.AddSingleton<IRacerService, RacerService>();
        services.AddSingleton<IGameSessionService, GameSessionService>();

        // Multiplayer
        services.AddSignalR().AddJsonProtocol(options =>
        {
            options.PayloadSerializerOptions.Converters.Add(
                new System.Text.Json.Serialization.JsonStringEnumConverter());
        });
        services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.Converters.Add(
                new System.Text.Json.Serialization.JsonStringEnumConverter());
        });
        services.AddSingleton<IMultiplayerGameRegistry, MultiplayerGameRegistry>();
        services.AddSingleton<IMultiplayerService, MultiplayerService>();

        // Lobby
        services.AddSingleton<ILobbyService, LobbyService>();

        return services;
    }
}
