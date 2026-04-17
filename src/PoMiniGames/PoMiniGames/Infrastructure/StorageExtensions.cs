using PoMiniGames.HealthChecks;
using PoMiniGames.Services;

namespace PoMiniGames.Infrastructure;

/// <summary>Registers SQLite storage services and the associated health check.</summary>
internal static class StorageExtensions
{
    public static IServiceCollection AddPoMiniGamesStorage(this IServiceCollection services)
    {
        services.AddSingleton<StorageService>();
        services.AddSingleton<IStorageService>(sp => sp.GetRequiredService<StorageService>());
        services.AddSingleton<IPlayerStatsStorage>(sp => sp.GetRequiredService<StorageService>());
        services.AddSingleton<ISnakeStorage>(sp => sp.GetRequiredService<StorageService>());
        services.AddSingleton<IPoDropSquareStorage>(sp => sp.GetRequiredService<StorageService>());

        services.AddHealthChecks()
            .AddCheck<StorageHealthCheck>("SqliteStorage");

        return services;
    }
}
