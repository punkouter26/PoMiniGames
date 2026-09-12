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
    private readonly Lazy<OpenAI.OpenAIClient?> _compatibleClient;
    private readonly IOptionsMonitor<AIFoundryOptions> _options;

    /// <param name="optionsMonitor">Bound from the <c>PoMiniGames:AI</c> section via KV
    /// (see <see cref="AIFoundryOptions.SectionName"/>).</param>
    /// <param name="logger">Source-generated logger; captures the one-time init outcome.</param>
    public AIFoundryClientFactory(
        IOptionsMonitor<AIFoundryOptions> optionsMonitor,
        ILogger<AIFoundryClientFactory> logger)
    {
        _options = optionsMonitor;

        // Lazy + TryAdd semantics: a misconfigured prod deployment resolves to null
        // (the per-call gates then throw InvalidOperationException rather than fabricate).
        _client = new Lazy<AzureOpenAIClient?>(() =>
        {
            var opts = optionsMonitor.CurrentValue;
            if (!opts.IsConfigured || !opts.IsAzureProvider)
            {
                if (!opts.IsConfigured) logger.AIFoundryNotConfigured();
                return null;
            }

            logger.AIFoundryInitialised(opts.Endpoint, opts.DefaultDeployment);

            return new AzureOpenAIClient(
                new Uri(opts.Endpoint),
                new Azure.Identity.DefaultAzureCredential(),
                AzureOpenAIResilience.DefaultOptions());
        });

        // The OpenAI-compatible path: Ollama, Gemini's compatibility endpoint, or anything else
        // that speaks the same wire protocol. Deliberately the same SDK surface — OpenAIClient and
        // AzureOpenAIClient both hand back OpenAI.Chat.ChatClient — so nothing downstream
        // (decorators, options cache, resilience pipeline) needs to know which one it got.
        _compatibleClient = new Lazy<OpenAI.OpenAIClient?>(() =>
        {
            var opts = optionsMonitor.CurrentValue;
            if (!opts.IsConfigured || opts.IsAzureProvider)
                return null;

            logger.AIFoundryInitialised(opts.Endpoint, opts.DefaultDeployment);

            var options = new OpenAI.OpenAIClientOptions
            {
                Endpoint = new Uri(opts.Endpoint),
                // Same posture as the Azure client: SDK retries off, because the Polly pipeline is
                // the source of truth for the total-call budget and the circuit state. Leaving the
                // SDK's own retries on is what turned one relay call into 51.6 s.
                NetworkTimeout = AzureOpenAIResilience.NetworkTimeout,
                RetryPolicy = new System.ClientModel.Primitives.ClientRetryPolicy(
                    AzureOpenAIResilience.MaxSdkRetries),
            };

            // Local runtimes ignore the key but the SDK requires a non-empty credential. A hosted
            // provider answers 401 to the placeholder, which is the correct loud failure.
            var key = string.IsNullOrWhiteSpace(opts.ApiKey) ? "no-key-configured" : opts.ApiKey;
            return new OpenAI.OpenAIClient(new System.ClientModel.ApiKeyCredential(key), options);
        });
    }

    /// <summary>
    /// The shared <see cref="AzureOpenAIClient"/>, or <c>null</c> when the foundry endpoint is not
    /// configured <b>or</b> the configured provider is not Azure (callers must check).
    /// </summary>
    /// <remarks>
    /// Prefer <see cref="GetChatClient"/> / <see cref="GetEmbeddingClient"/>, which are
    /// provider-neutral. This property stays Azure-typed because it is what the Azure-specific
    /// paths (deployment listing, Managed Identity assertions) legitimately need.
    /// </remarks>
    public AzureOpenAIClient? Client => _client.Value;

    /// <summary>True when a client of either kind can be built.</summary>
    public bool IsAvailable => _client.Value is not null || _compatibleClient.Value is not null;

    /// <summary>
    /// A chat client for <paramref name="deployment"/> from whichever provider is configured, or
    /// null when none is. On the OpenAI-compatible path the "deployment" is the model id.
    /// </summary>
    public OpenAI.Chat.ChatClient? GetChatClient(string deployment)
    {
        if (string.IsNullOrWhiteSpace(deployment)) return null;
        return _options.CurrentValue.IsAzureProvider
            ? _client.Value?.GetChatClient(deployment)
            : _compatibleClient.Value?.GetChatClient(deployment);
    }

    /// <summary>An embedding client for <paramref name="deployment"/>, or null when unconfigured.</summary>
    public OpenAI.Embeddings.EmbeddingClient? GetEmbeddingClient(string deployment)
    {
        if (string.IsNullOrWhiteSpace(deployment)) return null;
        return _options.CurrentValue.IsAzureProvider
            ? _client.Value?.GetEmbeddingClient(deployment)
            : _compatibleClient.Value?.GetEmbeddingClient(deployment);
    }
}
