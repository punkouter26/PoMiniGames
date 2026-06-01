using System.Globalization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using PoMiniGames.Application.Diagnostics;

namespace PoMiniGames.Features.Health;

public static class DiagEndpoints
{
    public static IEndpointRouteBuilder MapDiagEndpoints(this IEndpointRouteBuilder app)
    {
        async Task<IResult> diagHandler(IConfiguration configuration, IHostEnvironment environment, IDiagnosticsSnapshotProvider diagnosticsProvider)
        {
            var diagnosticsEnabled = configuration.GetValue("FeatureFlags:EnableDiagnostics", environment.IsDevelopment());
            if (!diagnosticsEnabled)
            {
                return Results.NotFound();
            }

            // Adapter-style endpoint: transport concerns stay here, while diagnostics assembly
            // is delegated to an application-facing provider for Onion-style separation.
            var diagData = await diagnosticsProvider.BuildSnapshotAsync();
            return Results.Ok(diagData);
        }

        app.MapGet("/api/diag", diagHandler)
        .WithName("GetDiagnostics")
        .WithTags("Health")
        .WithSummary("Exposes a development-focused diagnostic summary without raw secret values");

        // Note: /diag is NOT registered as an API endpoint to avoid conflicting with
        // the Blazor page route at /diag. Use /api/diag for programmatic access.

        // ─── Log tail endpoint for dev diagnostics ───────────────────────
        async Task<IResult> logsTailHandler(IConfiguration config, IHostEnvironment environment, int? lines = 50)
        {
            var diagnosticsEnabled = config.GetValue("FeatureFlags:EnableDiagnostics", environment.IsDevelopment());
            if (!diagnosticsEnabled)
                return Results.NotFound();

            try
            {
                var logsDir = Path.Combine(environment.ContentRootPath, "logs");
                if (!Directory.Exists(logsDir))
                    return Results.Ok(new { message = "No logs directory found", entries = Array.Empty<string>() });

                var latestLog = Directory.GetFiles(logsDir, "*.log")
                    .OrderByDescending(f => File.GetLastWriteTime(f))
                    .FirstOrDefault();

                if (latestLog == null)
                    return Results.Ok(new { message = "No log files found", entries = Array.Empty<string>() });

                var lineCount = lines ?? 50;
                var entries = File.ReadAllLines(latestLog)
                    .TakeLast(lineCount)
                    .ToArray();

                return Results.Ok(new
                {
                    file = Path.GetFileName(latestLog),
                    totalLines = File.ReadLines(latestLog).Count(),
                    shownLines = entries.Length,
                    entries = entries
                });
            }
            catch (Exception ex)
            {
                return Results.Ok(new { error = ex.Message });
            }
        }

        app.MapGet("/api/logs/tail", logsTailHandler)
        .WithName("GetLogsTail")
        .WithTags("Health")
        .WithSummary("Tail the latest development log file (dev-only)");

        return app;
    }
}

