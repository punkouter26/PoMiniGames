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
            // Lightweight connectivity test: list tables with a prefix
            await foreach (var _ in _client.QueryAsync(filter: "TableName eq 'PlayerStats'", cancellationToken: cancellationToken))
            {
                break;
            }
            return HealthCheckResult.Healthy("Azure Table Storage is reachable.");
        }
        catch (Exception ex)
        {
            return HealthCheckResult.Unhealthy(
                "Azure Table Storage unreachable.", ex);
        }
    }
}
