using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;

namespace PoMiniGames.Features.Health;

public static class DiagEndpoints
{
    public static IEndpointRouteBuilder MapDiagEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/diag", (IConfiguration configuration, IHostEnvironment environment) =>
        {
            var diagnosticsEnabled = configuration.GetValue("FeatureFlags:EnableDiagnostics", environment.IsDevelopment());
            if (!diagnosticsEnabled)
            {
                return Results.NotFound();
            }

            var diagData = new Dictionary<string, object?>
            {
                ["Sqlite:DataDirectory"] = MaskValue(configuration["Sqlite:DataDirectory"]),
                ["Sqlite__DataDirectory"] = MaskValue(configuration["Sqlite:DataDirectory"]),
                ["environment"] = new
                {
                    name = environment.EnvironmentName,
                    application = environment.ApplicationName,
                    urls = MaskValue(configuration["ASPNETCORE_URLS"] ?? configuration["URLS"]),
                },
                ["storage"] = new
                {
                    dataDirectory = MaskValue(configuration["Sqlite:DataDirectory"]),
                    databaseFileName = configuration["Sqlite:DatabaseFileName"] ?? "(null)",
                },
                ["logging"] = new
                {
                    defaultLevel = configuration["Serilog:MinimumLevel:Default"]
                        ?? configuration["Logging:LogLevel:Default"]
                        ?? "(null)",
                    devLogFile = environment.IsDevelopment() ? "logs/pominigames-.log" : "(disabled)",
                },
                ["featureFlags"] = new
                {
                    enableSwagger = configuration.GetValue("FeatureFlags:EnableSwagger", false),
                    enableDiagnostics = diagnosticsEnabled,
                },
                ["integrations"] = new
                {
                    keyVaultConfigured = HasConfiguredValue(configuration, "PoMiniGames:KeyVault:Uri", "KeyVault:Uri"),
                    applicationInsightsConfigured = HasConfiguredValue(
                        configuration,
                        "PoMiniGames:ApplicationInsights:ConnectionString",
                        "APPLICATIONINSIGHTS_CONNECTION_STRING",
                        "APPINSIGHTS_CONNECTIONSTRING"),
                    microsoftAuthConfigured = HasConfiguredValue(
                        configuration,
                        "PoMiniGames:MicrosoftAuth:ClientId",
                        "PoMiniGames:MicrosoftAuth:ApiClientId"),
                },
                ["cors"] = new
                {
                    allowedOrigins = ReadOrigins(configuration),
                },
            };

            return Results.Ok(diagData);
        })
        .WithName("GetDiagnostics")
        .WithTags("Health")
        .WithSummary("Exposes a development-focused diagnostic summary without raw secret values");

        return app;
    }

    private static bool HasConfiguredValue(IConfiguration configuration, params string[] keys)
    {
        foreach (var key in keys)
        {
            if (!string.IsNullOrWhiteSpace(configuration[key]))
            {
                return true;
            }
        }

        return false;
    }

    private static string MaskValue(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "(null)";
        }

        if (value.Length <= 8)
        {
            return "******";
        }

        return value[..4] + "..." + value[^4..];
    }

    private static string[] ReadOrigins(IConfiguration configuration)
    {
        var origins = configuration.GetSection("PoMiniGames:Cors:AllowedOrigins").Get<string[]>()
            ?? configuration.GetSection("Cors:AllowedOrigins").Get<string[]>()
            ?? [];

        return origins
            .Where(origin => !string.IsNullOrWhiteSpace(origin))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }
}

