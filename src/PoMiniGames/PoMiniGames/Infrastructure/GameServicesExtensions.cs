using PoMiniGames.Domain.Services;
using PoMiniGames.Features.PoRaceRagdoll;
using PoMiniGames.Infrastructure.Services;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Registers all game-specific services used by the local-only app.
/// </summary>
internal static class GameServicesExtensions
{
    public static IServiceCollection AddPoMiniGamesGameServices(this IServiceCollection services)
    {
        // PoRaceRagdoll
        services.AddSingleton<IRacerService, RacerService>();
        services.AddSingleton<IGameSessionService, GameSessionService>();

        // Elo calculation with configurable options
        services.Configure<EloOptions>(options =>
        {
            // Default values from EloOptions class will be used unless overridden in config
        });
        services.AddSingleton(sp =>
        {
            var config = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<EloOptions>>();
            return new EloCalculator(config.Value);
        });

        services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.Converters.Add(
                new System.Text.Json.Serialization.JsonStringEnumConverter());
        });

        return services;
    }
}
