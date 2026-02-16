using Microsoft.ApplicationInsights.Channel;
using Microsoft.ApplicationInsights.DataContracts;
using Microsoft.ApplicationInsights.Extensibility;

namespace PoMiniGames.HealthChecks;

/// <summary>
/// Filters out health check requests from Application Insights telemetry to reduce noise.
/// </summary>
public class HealthCheckFilter : ITelemetryProcessor
{
    private readonly ITelemetryProcessor _next;

    public HealthCheckFilter(ITelemetryProcessor next)
    {
        _next = next;
    }

    public void Process(ITelemetry item)
    {
        if (item is RequestTelemetry request && request.Url?.AbsolutePath.Contains("/health") == true)
        {
            return; // Filter out health check requests
        }

        _next.Process(item);
    }
}
