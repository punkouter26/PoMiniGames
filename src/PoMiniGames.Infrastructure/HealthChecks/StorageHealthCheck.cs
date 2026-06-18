using Microsoft.Extensions.Diagnostics.HealthChecks;
using PoMiniGames.Application.Services;

namespace PoMiniGames.Infrastructure.HealthChecks;

/// <summary>
/// Health check that verifies the storage backend is accessible
/// by performing a lightweight leaderboard read.
/// </summary>
public sealed class StorageHealthCheck : IHealthCheck
{
    private readonly IStorageService _storage;

    public StorageHealthCheck(IStorageService storage)
    {
        _storage = storage;
    }

    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        try
        {
            // Try a read on the health-check probe partition
            await _storage.GetLeaderboardAsync("healthcheck", 1);
            return HealthCheckResult.Healthy("Storage is accessible.");
        }
        catch (Exception ex)
        {
            return HealthCheckResult.Unhealthy("Storage is unavailable.", ex);
        }
    }
}
