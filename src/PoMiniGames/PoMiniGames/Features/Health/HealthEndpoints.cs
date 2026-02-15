using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace PoMiniGames.Features.Health;

/// <summary>
/// Minimal API health endpoints.
/// GET /api/health  → structured health report
/// GET /api/health/ping → simple OK
/// </summary>
public static class HealthEndpoints
{
    public static IEndpointRouteBuilder MapHealthEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/health", async (HealthCheckService healthCheckService) =>
        {
            var report = await healthCheckService.CheckHealthAsync();
            var response = new
            {
                status = report.Status.ToString(),
                checks = report.Entries.Select(e => new
                {
                    name = e.Key,
                    status = e.Value.Status.ToString(),
                    description = e.Value.Description,
                    duration = e.Value.Duration.TotalMilliseconds,
                }),
                totalDuration = report.TotalDuration.TotalMilliseconds,
            };

            return report.Status == HealthStatus.Healthy
                ? Results.Ok(response)
                : Results.Json(response, statusCode: StatusCodes.Status503ServiceUnavailable);
        })
        .WithName("HealthCheck")
        .WithTags("Health")
        .WithSummary("Structured health report for all dependencies");

        app.MapGet("/api/health/ping", () => Results.Ok("pong"))
            .WithName("HealthPing")
            .WithTags("Health")
            .WithSummary("Simple liveness probe");

        return app;
    }
}
