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

        app.MapGet("/diag", diagHandler)
        .WithName("GetDiagnosticsRoot")
        .WithTags("Health")
        .WithSummary("Diagnostic summary (root alias)");

        return app;
    }
}

