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
    /// <summary>Constant <c>cloud_RoleName</c> for App Insights. Bound at compile time so the
    /// resource service.name never collapses to <c>unknown_service:dotnet</c>. Only the API host
    /// sets this; the Blazor WASM client does not call <c>AddPoMiniGamesTelemetry()</c>, so the
    /// reflection guard ("don't execute this in Blazor WASM") becomes a structural one.</summary>
    public const string CloudRoleName = "PoMiniGames";

    /// <summary>Adds Azure Monitor / OpenTelemetry when an App Insights connection string is present.</summary>
    public static WebApplicationBuilder AddPoMiniGamesTelemetry(this WebApplicationBuilder builder)
    {
        var appInsightsConnString = builder.Configuration["PoMiniGames:ApplicationInsights:ConnectionString"]
            ?? builder.Configuration["APPLICATIONINSIGHTS_CONNECTION_STRING"]
            ?? builder.Configuration["APPINSIGHTS_CONNECTIONSTRING"];

        if (!string.IsNullOrEmpty(appInsightsConnString))
        {
            // cloud_RoleName is bound to a constant — never reflect against the executing
            // assembly at runtime (which can collide on trimming / single-file publish).
            var roleName = CloudRoleName;

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
