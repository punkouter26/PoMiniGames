using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;

namespace PoMiniGames.Features.Health;

public static class DiagEndpoints
{
    public static IEndpointRouteBuilder MapDiagEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/diag", (IConfiguration configuration) =>
        {
            var diagData = new Dictionary<string, string>();
            
            foreach (var kvp in configuration.AsEnumerable())
            {
                if (string.IsNullOrEmpty(kvp.Value))
                {
                    diagData[kvp.Key] = "(null)";
                    continue;
                }

                // Hide middle of values for security
                var val = kvp.Value;
                if (val.Length > 8)
                {
                    diagData[kvp.Key] = val.Substring(0, 4) + "..." + val.Substring(val.Length - 4);
                }
                else
                {
                    diagData[kvp.Key] = "******";
                }
            }

            return Results.Ok(diagData);
        })
        .WithName("GetDiagnostics")
        .WithTags("Health")
        .WithSummary("Exposes filtered configuration and secrets for debugging");

        return app;
    }
}
