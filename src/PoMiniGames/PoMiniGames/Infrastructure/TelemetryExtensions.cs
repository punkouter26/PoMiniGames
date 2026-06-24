using System.Reflection;
using Azure.Identity;
using Azure.Monitor.OpenTelemetry.AspNetCore;
using OpenTelemetry.Instrumentation.AspNetCore;
using OpenTelemetry.Resources;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Registers OpenTelemetry + Azure Application Insights, and Azure Key Vault configuration.
/// Both services are cloud-only: no-ops in Development when the relevant config keys are absent.
/// </summary>
internal static class TelemetryExtensions
{
    /// <summary>Adds Azure Monitor / OpenTelemetry when an App Insights connection string is present.</summary>
    public static WebApplicationBuilder AddPoMiniGamesTelemetry(this WebApplicationBuilder builder)
    {
        var appInsightsConnString = builder.Configuration["PoMiniGames:ApplicationInsights:ConnectionString"]
            ?? builder.Configuration["APPLICATIONINSIGHTS_CONNECTION_STRING"]
            ?? builder.Configuration["APPINSIGHTS_CONNECTIONSTRING"];

        if (!string.IsNullOrEmpty(appInsightsConnString))
        {
            // Map cloud_RoleName to the executing assembly name (never "unknown_service:dotnet").
            // Under the Azure Monitor OTel distro the classic ITelemetryInitializer is replaced by
            // the OTel Resource service.name, which Azure Monitor surfaces as cloud_RoleName.
            var roleName = Assembly.GetExecutingAssembly().GetName().Name ?? "PoMiniGames";

            // Adaptive sampling profile: full fidelity in Dev/Test, ~10% ceiling in Production.
            // Exceptions are always emitted at Error level so failures remain fully visible.
            var samplingRatio = builder.Environment.IsProduction() ? 0.1f : 1.0f;

            builder.Services.AddOpenTelemetry()
                .ConfigureResource(resource => resource.AddService(roleName))
                .UseAzureMonitor(opts =>
                {
                    opts.ConnectionString = appInsightsConnString;
                    opts.SamplingRatio = samplingRatio;
                    // QuickPulse / Live Metrics stays enabled globally (distro default).
                    opts.EnableLiveMetrics = true;
                });

            // Ingestion-budget guard: never record request traces for the
            // high-frequency, low-value probe endpoints (load-balancer health
            // pings, CI smoke tests, uptime monitors). These would otherwise
            // dominate the F1-tier ingestion budget with zero diagnostic value.
            // Exceptions and non-probe traffic remain governed by SamplingRatio.
            builder.Services.Configure<AspNetCoreTraceInstrumentationOptions>(o =>
            {
                o.Filter = context =>
                {
                    var path = context.Request.Path.Value ?? string.Empty;
                    return !(path.StartsWith("/health", StringComparison.OrdinalIgnoreCase)
                          || path.StartsWith("/api/health", StringComparison.OrdinalIgnoreCase));
                };
            });
        }

        return builder;
    }

    /// <summary>Adds Azure Key Vault configuration source when the vault URI is present.</summary>
    public static WebApplicationBuilder AddPoMiniGamesKeyVault(this WebApplicationBuilder builder)
    {
        var keyVaultUri = builder.Configuration["PoMiniGames:KeyVault:Uri"]
            ?? builder.Configuration["KeyVault:Uri"];

        if (!string.IsNullOrEmpty(keyVaultUri))
        {
            builder.Configuration.AddAzureKeyVault(
                new Uri(keyVaultUri),
                new DefaultAzureCredential(),
                new PrefixKeyVaultSecretManager("PoMiniGames"));
        }

        return builder;
    }
}
