using Azure.Identity;
using Azure.Monitor.OpenTelemetry.AspNetCore;

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
            builder.Services.AddOpenTelemetry().UseAzureMonitor(opts =>
            {
                opts.ConnectionString = appInsightsConnString;
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
