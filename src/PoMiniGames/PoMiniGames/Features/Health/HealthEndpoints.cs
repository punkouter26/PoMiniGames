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
        async Task<IResult> healthHandler(HealthCheckService healthCheckService)
        {
            var report = await healthCheckService.CheckHealthAsync();
            var response = CreateHealthResponse(report);
            return report.Status != HealthStatus.Unhealthy
                ? Results.Ok(response)
                : Results.Json(response, statusCode: StatusCodes.Status503ServiceUnavailable);
        }

        app.MapGet("/api/health", healthHandler)
        .WithName("HealthCheck")
        .WithTags("Health")
        .WithSummary("Structured health report for all dependencies");

        app.MapGet("/health", healthHandler)
        .WithName("HealthCheckRoot")
        .WithTags("Health")
        .WithSummary("Structured health report (root alias)");

        app.MapGet("/api/health/ping", () => Results.Ok("pong"))
            .WithName("HealthPing")
            .WithTags("Health")
            .WithSummary("Simple liveness probe");

        return app;
    }

    private static dynamic CreateHealthResponse(HealthReport report)
    {
        return new
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
            checkedAtUtc = DateTimeOffset.UtcNow,
        };
    }
}

