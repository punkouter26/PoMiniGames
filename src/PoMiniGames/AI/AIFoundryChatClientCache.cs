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
        var foundry = _factory.Client;
        if (foundry is null) return null;

        var deployment = _optionsMonitor.CurrentValue.ResolveDeployment(gameKey);
        return _cache.GetOrAdd(deployment, foundry.GetChatClient(deployment));
    }

    /// <summary>Returns an <see cref="IChatClient"/> (ME.AI) wrapper around the cached
    /// <see cref="ChatClient"/>, suitable for code that targets the cross-provider abstraction.</summary>
    public IChatClient? ResolveAsIChatClient(string gameKey)
    {
        var chat = Resolve(gameKey);
        return chat?.AsIChatClient();
    }
}
