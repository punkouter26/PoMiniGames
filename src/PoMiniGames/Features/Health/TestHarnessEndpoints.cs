using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace PoMiniGames.Features.Health;

/// <summary>
/// Local-only test harness endpoints for UI/gameplay validation without API dependencies.
/// Enables rapid local iteration by allowing offline game testing and deterministic scenarios.
/// </summary>
public static class TestHarnessEndpoints
{
    public static IEndpointRouteBuilder MapTestHarnessEndpoints(this IEndpointRouteBuilder app, IHostEnvironment env)
    {
        if (!env.IsDevelopment())
            return app;

        // §1 MapGroup() per slice: all /test/* routes share the same prefix,
        // OpenAPI tag ("Testing"), and the dev-only env guard applied here.
        var test = app.MapGroup("/test").WithTags("Testing");

        /// <summary>GET /test/offline-mode → Forces all API calls to fail, tests offline resilience</summary>
        test.MapGet("/offline-mode", () =>
        {
            return Results.Ok(new
            {
                message = "Offline mode activated",
                instructions = new[]
                {
                    "Set localStorage['_offline_test'] = 'true' in browser console",
                    "Reload game page",
                    "Games should work without API",
                    "Scores won't sync until online again"
                },
                example = "localStorage.setItem('_offline_test', 'true'); location.reload();"
            });
        })
        .WithName("GetOfflineModeInstructions")
        .WithSummary("Instructions for testing offline game functionality");

        /// <summary>GET /test/render-diagnostics → Canvas/WebGL render pipeline debug</summary>
        test.MapGet("/render-diagnostics", () =>
        {
            return Results.Ok(new
            {
                message = "Canvas/WebGL render diagnostics",
                checklist = new[]
                {
                    "1. Open DevTools → Performance → Start Recording",
                    "2. Navigate to a game that triggers a canvas redraw",
                    "3. Stop recording after 2-3 seconds",
                    "4. Look for long task / layout thrash / Paint events",
                    "5. Check React Profiler for janky commits",
                    "6. Verify window.gameDebug* objects exist in console"
                },
                expectedObjects = new[] { "window.gameDebug", "window.gameLog" }
            });
        })
        .WithName("GetRenderDiagnostics")
        .WithSummary("Render pipeline diagnostics for Canvas/WebGL games");

        /// <summary>GET /test/api-timeout → Simulate slow API responses</summary>
        test.MapGet("/api-timeout", async (HttpContext context) =>
        {
            await Task.Delay(8000); // Exceed 5s client timeout
            return Results.Ok(new { message = "Response after timeout window" });
        })
        .WithName("GetSlowApiResponse")
        .WithSummary("Simulates slow API response (tests client timeout handling)");

        return app;
    }
}
