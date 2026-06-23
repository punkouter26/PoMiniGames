namespace PoSurvive.Infrastructure.Configuration;

using Microsoft.Extensions.Configuration;

/// <summary>
/// Typed wrapper around IConfiguration for Key Vault–backed secrets.
/// Azure Key Vault is registered as a configuration provider in Program.cs using Managed Identity,
/// so secrets are accessible through the standard IConfiguration abstraction with their vault name.
/// </summary>
public sealed class KeyVaultSecretProvider
{
    private readonly IConfiguration _configuration;

    public KeyVaultSecretProvider(IConfiguration configuration)
    {
        _configuration = configuration;
    }

    /// <summary>
    /// Returns the Azure Table Storage connection string from Key Vault secret
    /// <c>PoSurvive-TableStorageConnectionString</c>.
    /// Falls back to the Azurite dev connection string when running locally.
    /// </summary>
    public string GetTableStorageConnectionString()
        => _configuration.GetConnectionString("AzuriteTableStorage")
           ?? _configuration["PoSurvive-TableStorageConnectionString"]
           ?? throw new InvalidOperationException(
               "Secret 'PoSurvive-TableStorageConnectionString' not found in configuration. " +
               "Ensure Key Vault is configured or ConnectionStrings:AzuriteTableStorage is set for local dev.");

    /// <summary>
    /// Returns the Application Insights connection string from Key Vault secret
    /// <c>AppInsights-ConnectionString</c>.
    /// </summary>
    public string GetAppInsightsConnectionString()
        => _configuration["AppInsights-ConnectionString"]
           ?? throw new InvalidOperationException(
               "Secret 'AppInsights-ConnectionString' not found in configuration. " +
               "Ensure Key Vault is configured with the 'AppInsights-ConnectionString' secret.");
}
