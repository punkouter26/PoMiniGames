using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using PoMiniGames.Services;

namespace PoMiniGames.HealthChecks;

/// <summary>
/// Health check that verifies SQLite storage is accessible
/// by opening a connection to the data directory.
/// </summary>
public sealed class StorageHealthCheck : IHealthCheck
{
    private readonly StorageService _storage;

    public StorageHealthCheck(StorageService storage)
    {
        _storage = storage;
    }

    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        try
        {
            // Try a read on the health-check probe database
            await _storage.GetLeaderboardAsync("healthcheck", 1);
            return HealthCheckResult.Healthy("SQLite storage is accessible.");
        }
        catch (Exception ex)
        {
            return HealthCheckResult.Unhealthy("SQLite storage is unavailable.", ex);
        }
    }
}

