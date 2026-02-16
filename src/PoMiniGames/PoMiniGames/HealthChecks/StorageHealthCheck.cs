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
            var tableClient = _client.GetTableClient("PlayerStats");
            await tableClient.CreateIfNotExistsAsync(cancellationToken);
            
            await foreach (var _ in tableClient.QueryAsync<TableEntity>(maxPerPage: 1, cancellationToken: cancellationToken))
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
