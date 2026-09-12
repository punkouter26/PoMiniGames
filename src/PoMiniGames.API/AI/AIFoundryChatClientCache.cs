using System.Collections.Concurrent;
using Azure.AI.OpenAI;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;
using OpenAI.Chat;

namespace PoMiniGames.AI;

/// <summary>
/// Resolves a cached <see cref="ChatClient"/> per deployment name from the shared
/// <see cref="AIFoundryClientFactory"/>. Cache is keyed by deployment name; deployments
/// are immutable per app lifetime (rotating a deployment means restarting the app), so
/// the cache never evicts.
/// </summary>
/// <remarks>
/// GoF: Flyweight — shares one <see cref="AzureOpenAIClient"/> and one
/// <see cref="ChatClient"/> per deployment across all callers.
/// </remarks>
public sealed class AIFoundryChatClientCache
{
    private readonly AIFoundryClientFactory _factory;
    private readonly IOptionsMonitor<AIFoundryOptions> _optionsMonitor;
    private readonly ConcurrentDictionary<string, ChatClient> _cache = new(StringComparer.OrdinalIgnoreCase);

    public AIFoundryChatClientCache(
        AIFoundryClientFactory factory,
        IOptionsMonitor<AIFoundryOptions> optionsMonitor)
    {
        _factory = factory;
        _optionsMonitor = optionsMonitor;
    }

    /// <summary>Returns a cached <see cref="ChatClient"/> for the deployment matching the supplied
    /// game key. Returns <c>null</c> when the foundry client is not configured (caller must check).</summary>
    public ChatClient? Resolve(string gameKey)
    {
        var deployment = _optionsMonitor.CurrentValue.ResolveDeployment(gameKey);
        return ResolveByDeployment(deployment);
    }

    /// <summary>Returns an <see cref="IChatClient"/> (ME.AI) wrapper around the cached
    /// <see cref="ChatClient"/>, suitable for code that targets the cross-provider abstraction.</summary>
    public IChatClient? ResolveAsIChatClient(string gameKey)
    {
        var chat = Resolve(gameKey);
        return chat?.AsIChatClient();
    }

    /// <summary>
    /// Resolves a client for an explicit <b>deployment name</b> rather than a game key, for the
    /// per-request model selection <c>/api/infer</c> exposes. Callers must have validated the name
    /// against a server-side allowlist first — this method does not.
    /// </summary>
    /// <remarks>
    /// Without this, per-request selection was impossible: the game's <see cref="IChatClient"/> is
    /// bound to one deployment at construction, so <c>InferWithModelAsync</c> logged the requested
    /// id and answered from the default anyway.
    /// </remarks>
    public IChatClient? ResolveDeploymentAsIChatClient(string deployment)
    {
        return ResolveByDeployment(deployment)?.AsIChatClient();
    }

    /// <summary>
    /// The cached client for an explicit deployment, from whichever provider is configured.
    /// </summary>
    /// <remarks>
    /// Goes through <see cref="AIFoundryClientFactory.GetChatClient"/> rather than reaching for the
    /// Azure-typed <c>Client</c> property, so an OpenAI-compatible backend (Ollama, Gemini) is
    /// served by the same flyweight cache and the same downstream decorators.
    /// </remarks>
    private ChatClient? ResolveByDeployment(string deployment)
    {
        if (string.IsNullOrWhiteSpace(deployment)) return null;
        if (_cache.TryGetValue(deployment, out var cached)) return cached;

        var client = _factory.GetChatClient(deployment);
        return client is null ? null : _cache.GetOrAdd(deployment, client);
    }
}
