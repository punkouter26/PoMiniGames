using Azure.Data.Tables;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace PoMiniGames.HealthChecks;

/// <summary>
/// Health check that verifies Azure Table Storage connectivity
/// by attempting to create/query a test table.
/// </summary>
public sealed class StorageHealthCheck : IHealthCheck
{
    private readonly TableServiceClient _client;

    public StorageHealthCheck(TableServiceClient client)
    {
        _client = client;
    }

    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        try
        {
            // Attempt to get service properties — lightweight connectivity test
            await _client.GetPropertiesAsync(cancellationToken);
            return HealthCheckResult.Healthy("Azure Table Storage is reachable.");
        }
        catch (Exception ex)
        {
            return HealthCheckResult.Unhealthy(
                "Azure Table Storage unreachable.", ex);
        }
    }
}
