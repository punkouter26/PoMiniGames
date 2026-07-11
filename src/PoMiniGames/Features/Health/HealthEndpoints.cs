using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace PoMiniGames.Features.Health;

/// <summary>
/// Minimal API health endpoints, all under a single <c>/api/health/*</c> prefix.
/// <list type="bullet">
///   <item><c>GET /api/health</c> — structured health report (the legacy contract)</item>
///   <item><c>GET /api/health/liveness</c> — process-is-up liveness probe (alias of <c>/api/health</c>)</item>
///   <item><c>GET /api/health/ping</c> — zero-dependency <c>pong</c> (no health-check service)</item>
///   <item><c>GET /health</c> — non-prefixed alias kept only for App Service probe compatibility;
///         new callers must use <c>/api/health</c>.</item>
/// </list>
/// </summary>
/// <remarks>
/// Pattern: Adapter over ASP.NET Core's <see cref="HealthCheckService"/>. The
/// application-composition root treats these URLs as a single namespace so
/// <c>curl .../api/health/...</c> is the only shape dev/ops/CI ever have to learn
/// (the previously-divergent <c>/health</c> and <c>/api/health/ping</c> pair was the
/// most-copy-pasted bug across the test suites — see <c>docs/qa-fixes-runbook.md</c>).
/// </remarks>
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

        // §1 MapGroup() per slice: every /api/health/* route lives under the same
        // group so the OpenAPI tag, auth gate (none — probes must stay anonymous),
        // and route prefix are declared once.
        var health = app.MapGroup("/api/health").WithTags("Health");

        health.MapGet("", healthHandler)
        .WithName("HealthCheck")
        .WithSummary("Structured health report for all dependencies");

        // Liveness is the standard Kubernetes / App Service probe shape:
        // "is the process alive?" — answered by the same health-check service but
        // named so the route table is self-documenting.
        health.MapGet("/liveness", healthHandler)
        .WithName("HealthLiveness")
        .WithSummary("Liveness probe (process alive). Alias of /api/health.");

        health.MapGet("/ping", () => Results.Ok("pong"))
            .WithName("HealthPing")
            .WithSummary("Simple liveness probe (no health-check service)");

        // Legacy root alias: kept so external monitors pointed at <c>/health</c>
        // continue to work. New callers must prefer <c>/api/health</c>. The
        // alias is intentionally NOT named in OpenAPI to discourage new code
        // from referencing it. NOT inside the /api/health group so the OpenAPI
        // tag stays /api/health only.
        app.MapGet("/health", healthHandler)
        .WithName("HealthCheckRootAlias")
        .WithTags("Health")
        .WithSummary("Structured health report (legacy root alias for App Service probes)")
        .ExcludeFromDescription();

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

