using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using PoMiniGames.Application.Diagnostics;

namespace PoMiniGames.Features.Health;

public static class DiagEndpoints
{
    public static IEndpointRouteBuilder MapDiagEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/diag", async (IConfiguration configuration, IHostEnvironment environment, IDiagnosticsSnapshotProvider diagnosticsProvider) =>
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
        })
        .WithName("GetDiagnostics")
        .WithTags("Health")
        .WithSummary("Exposes a development-focused diagnostic summary without raw secret values");

        return app;
    }
}

