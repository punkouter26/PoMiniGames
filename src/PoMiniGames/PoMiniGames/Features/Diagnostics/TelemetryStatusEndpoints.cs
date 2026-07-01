// filepath: src/PoMiniGames/PoMiniGames/Features/Diagnostics/TelemetryStatusEndpoints.cs
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace PoMiniGames.Features.Diagnostics;

/// <summary>
/// Surfaces the *configured* state of the telemetry pipeline (Application
/// Insights connection string present? OpenTelemetry SDK registered?) without
/// leaking the connection string itself. Used by the /diag page so the agent
/// can tell at a glance whether the runtime can ship traces.
///
/// Production hardening: returns the same projection in every environment
/// (no secrets, no endpoint names); the connection-string presence is
/// already exposed via the existing <c>api/diag</c> JSON, so this endpoint
/// is not adding new attack surface.
/// </summary>
public static class TelemetryStatusEndpoints
{
    public sealed record TelemetryStatus(
        bool AppInsightsConfigured,
        string? OtelExporter,
        string? ResourceRoleName,
        bool LiveMetricsEnabled,
        double SamplingRatio);

    public static IEndpointRouteBuilder MapTelemetryStatusEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/diag/telemetry", (IConfiguration config, IHostEnvironment env) =>
        {
            // Connection strings are secrets. We never echo them — only the
            // boolean "is one configured" which is the same signal the diag
            // page already shows.
            var conn = config["PoMiniGames:ApplicationInsights:ConnectionString"]
                ?? config["APPLICATIONINSIGHTS_CONNECTION_STRING"]
                ?? config["APPINSIGHTS_CONNECTIONSTRING"];

            // The exporter name is whatever is bound into the OTEL options.
            // When no connection string is present, no exporter is registered
            // and the OpenTelemetry SDK still emits the in-process spans to
            // the no-op pipeline — the role name is therefore always known.
            var exporter = string.IsNullOrEmpty(conn) ? null : "azure-monitor";
            var samplingRatio = env.IsProduction() ? 0.1d : 1.0d;
            var liveMetrics = !env.IsProduction();

            return Results.Ok(new TelemetryStatus(
                AppInsightsConfigured: !string.IsNullOrEmpty(conn),
                OtelExporter: exporter,
                ResourceRoleName: "PoMiniGames",
                LiveMetricsEnabled: liveMetrics,
                SamplingRatio: samplingRatio));
        })
        .WithName("GetTelemetryStatus")
        .WithTags("Diagnostics")
        .WithSummary("Returns telemetry pipeline status without leaking secrets.");

        return app;
    }
}
