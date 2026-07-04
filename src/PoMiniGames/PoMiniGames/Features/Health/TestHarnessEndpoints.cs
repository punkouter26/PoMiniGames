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

        /// <summary>GET /test/offline-mode → Forces all API calls to fail, tests offline resilience</summary>
        app.MapGet("/test/offline-mode", () =>
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
        .WithTags("Testing")
        .WithSummary("Instructions for testing offline game functionality");

        /// <summary>GET /test/keyboard-events → Test keyboard input capture</summary>
        app.MapGet("/test/keyboard-events", () =>
        {
            return Results.Ok(new
            {
                message = "Keyboard event test harness",
                instructions = new[]
                {
                    "Navigate to /porunner?mode=debug",
                    "Browser console will log all key presses",
                    "Expected keys: T, Y, G, H (sprint controls)",
                    "Check for keyboard event bubbling issues"
                }
            });
        })
        .WithName("GetKeyboardEventTest")
        .WithTags("Testing")
        .WithSummary("Debug keyboard input capture for games");

        /// <summary>GET /test/render-diagnostics → Canvas/WebGL render pipeline debug</summary>
        app.MapGet("/test/render-diagnostics", () =>
        {
            return Results.Ok(new
            {
                message = "Canvas/WebGL render diagnostics",
                checklist = new[]
                {
                    "1. Open DevTools → Performance → Start Recording",
                    "2. Navigate to /poclick (or any game that triggers a canvas redraw)",
                    "3. Stop recording after 2-3 seconds",
                    "4. Look for long task / layout thrash / Paint events",
                    "5. Check React Profiler for janky commits",
                    "6. Verify window.gameDebug* objects exist in console"
                },
                expectedObjects = new[] { "window.gameDebug", "window.gameLog" }
            });
        })
        .WithName("GetRenderDiagnostics")
        .WithTags("Testing")
        .WithSummary("Render pipeline diagnostics for Canvas/WebGL games");

        /// <summary>GET /test/api-timeout → Simulate slow API responses</summary>
        app.MapGet("/test/api-timeout", async (HttpContext context) =>
        {
            await Task.Delay(8000); // Exceed 5s client timeout
            return Results.Ok(new { message = "Response after timeout window" });
        })
        .WithName("GetSlowApiResponse")
        .WithTags("Testing")
        .WithSummary("Simulates slow API response (tests client timeout handling)");

        return app;
    }
}
