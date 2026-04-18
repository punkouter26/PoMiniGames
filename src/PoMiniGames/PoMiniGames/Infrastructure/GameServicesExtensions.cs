using PoMiniGames.Features.PoRaceRagdoll;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Registers all game-specific services used by the local-only app.
/// </summary>
internal static class GameServicesExtensions
{
    public static IServiceCollection AddPoMiniGamesGameServices(this IServiceCollection services)
    {
        // PoRaceRagdoll
        services.AddSingleton<IOddsService, OddsService>();
        services.AddSingleton<IRacerService, RacerService>();
        services.AddSingleton<IGameSessionService, GameSessionService>();

        services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.Converters.Add(
                new System.Text.Json.Serialization.JsonStringEnumConverter());
        });

        return services;
    }
}
