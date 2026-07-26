using Azure.AI.OpenAI;
using Microsoft.Extensions.Options;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.AI;

/// <summary>
/// Constructs a single shared <see cref="AzureOpenAIClient"/> bound to the centralized
/// Azure AI Foundry hub in the <c>PoShared</c> resource group.
///
/// <para>
/// Replaces the per-game <c>AzureOpenAIClient</c> construction that was previously inlined in
/// each <c>Features/&lt;Game&gt;/AzureOpenAI*Service.cs</c> file. The single shared client:
/// <list type="bullet">
///   <item>Halves connection setup time (one pipeline, one auth handshake).</item>
///   <item>Centralises the per-call timeout / retry / circuit-breaker policy in one place
///         (<see cref="AzureOpenAIResilience"/>).</item>
///   <item>Provides a single point of audit for every model invocation routed through
///         OpenTelemetry → Application Insights.</item>
/// </list>
/// </para>
/// <para>
/// <b>Auth</b>: relies on the Web App's system-assigned Managed Identity to acquire an
/// AAD bearer token via <see cref="Azure.Identity.DefaultAzureCredential"/>; no API key
/// is ever stored in code, configuration, or Key Vault (matches the AI Foundry
/// <c>disableLocalAuth: true</c> posture).
/// </para>
/// </summary>
/// <remarks>
/// Singleton. Registered in <see cref="Infrastructure.GameServicesExtensions"/>.
/// </remarks>
public sealed class AIFoundryClientFactory
{
    private readonly Lazy<AzureOpenAIClient?> _client;

    /// <param name="optionsMonitor">Bound from the <c>PoMiniGames:AI</c> section via KV
    /// (see <see cref="AIFoundryOptions.SectionName"/>).</param>
    /// <param name="logger">Source-generated logger; captures the one-time init outcome.</param>
    public AIFoundryClientFactory(
        IOptionsMonitor<AIFoundryOptions> optionsMonitor,
        ILogger<AIFoundryClientFactory> logger)
    {
        // Lazy + TryAdd semantics: a misconfigured prod deployment resolves to null
        // (the per-call gates then throw InvalidOperationException rather than fabricate).
        _client = new Lazy<AzureOpenAIClient?>(() =>
        {
            var opts = optionsMonitor.CurrentValue;
            if (!opts.IsConfigured)
            {
                logger.AIFoundryNotConfigured();
                return null;
            }

            logger.AIFoundryInitialised(opts.Endpoint, opts.DefaultDeployment);

            return new AzureOpenAIClient(
                new Uri(opts.Endpoint),
                new Azure.Identity.DefaultAzureCredential(),
                AzureOpenAIResilience.DefaultOptions());
        });
    }

    /// <summary>The shared <see cref="AzureOpenAIClient"/>, or <c>null</c> when the
    /// foundry endpoint is not configured (callers must check).</summary>
    public AzureOpenAIClient? Client => _client.Value;
}
