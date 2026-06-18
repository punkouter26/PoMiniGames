using PoMiniGames.Application.Services;
using PoMiniGames.Infrastructure.HealthChecks;
using PoMiniGames.Infrastructure.Services;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace PoMiniGames.Infrastructure;

/// <summary>Registers Azure Table Storage services and the associated health check.</summary>
internal static class StorageExtensions
{
    public static IServiceCollection AddPoMiniGamesStorage(this IServiceCollection services)
    {
        services.AddSingleton<StorageService>();
        services.AddSingleton<IStorageService>(sp => sp.GetRequiredService<StorageService>());

        services.AddHealthChecks()
            .AddCheck<StorageHealthCheck>(
                "Storage",
                failureStatus: HealthStatus.Unhealthy,
                tags: new[] { "critical" })
            .AddCheck<AzureTableStorageHealthCheck>(
                "AzureTableStorage",
                failureStatus: HealthStatus.Degraded,
                tags: new[] { "optional" });

        return services;
    }
}
