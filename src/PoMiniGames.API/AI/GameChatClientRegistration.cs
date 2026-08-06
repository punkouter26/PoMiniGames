using System.Collections.Concurrent;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Polly.Registry;
using PoMiniGames.Shared.Simulation.Models;

namespace PoMiniGames.AI;

/// <summary>
/// Builds and caches the composed <see cref="IChatClient"/> a game talks to: the shared foundry
/// client wrapped in the telemetry and resilience decorators.
/// </summary>
/// <remarks>
/// <para>
/// Each AI-consuming slice previously reached into <see cref="AIFoundryChatClientCache"/> itself
/// and used the bare client. That left every cross-cutting guarantee opt-in, and every slice opted
/// out: the resilience pipeline had no consumers at all, and no call site recorded token usage.
/// Composing here means a slice gets the whole posture by asking for its client:
/// </para>
/// <code>
/// ResilientChatClient          // total-call budget, retry, circuit breaker
///   └─ InstrumentedChatClient  // token/latency logging, health tracking
///        └─ foundry ChatClient // the cached per-deployment client
/// </code>
/// <para>
/// The decorators nest in that order on purpose: telemetry inside the pipeline measures one
/// attempt's real service latency, and counts a retried attempt as the failure it was.
/// </para>
/// <para>
/// Composition is per <b>deployment</b>, not per game, because <c>/api/infer</c> lets a caller
/// select a model from the server-side allowlist. The first cut of this took the game's client
/// from DI and reached past it to the bare cache for any other deployment — so the moment the
/// client actually used per-request selection (which it does on every call, naming the deployment
/// the status endpoint reported), every guarantee here was bypassed again and the telemetry went
/// silent. One decorated client per deployment, cached, is what keeps that from being possible.
/// </para>
/// </remarks>
public sealed class GameChatClientFactory
{
    private readonly AIFoundryChatClientCache _cache;
    private readonly IOptionsMonitor<AIFoundryOptions> _options;
    private readonly ILoggerFactory _loggerFactory;
    private readonly AiUsageAccumulator _usage;
    private readonly IServiceProvider _services;
    private readonly ResiliencePipelineProvider<string> _pipelines;

    private readonly ConcurrentDictionary<string, IChatClient> _composed =
        new(StringComparer.OrdinalIgnoreCase);

    public GameChatClientFactory(
        AIFoundryChatClientCache cache,
        IOptionsMonitor<AIFoundryOptions> options,
        ILoggerFactory loggerFactory,
        AiUsageAccumulator usage,
        IServiceProvider services,
        ResiliencePipelineProvider<string> pipelines)
    {
        _cache = cache;
        _options = options;
        _loggerFactory = loggerFactory;
        _usage = usage;
        _services = services;
        _pipelines = pipelines;
    }

    /// <summary>
    /// The decorated client for <paramref name="gameKey"/>'s configured deployment. Throws when the
    /// foundry is unconfigured — callers with a mock path must check
    /// <see cref="AIFoundryOptions.IsConfigured"/> first rather than catching.
    /// </summary>
    public IChatClient ForGame(string gameKey)
        => ForDeployment(gameKey, _options.CurrentValue.ResolveDeployment(gameKey))
           ?? throw new InvalidOperationException(
               $"AIFoundry is not configured for game '{gameKey}'. Set {AIFoundryOptions.SectionName} " +
               "(FoundryEndpoint + DefaultDeployment) in Key Vault (kv-poshared) or configuration.");

    /// <summary>
    /// The decorated client for an explicit deployment, or null when the foundry is unconfigured.
    /// The caller must have validated <paramref name="deployment"/> against a server-side
    /// allowlist — this method does not.
    /// </summary>
    public IChatClient? ForDeployment(string gameKey, string deployment)
    {
        if (string.IsNullOrWhiteSpace(deployment))
            return null;

        var key = $"{gameKey}|{deployment}";
        if (_composed.TryGetValue(key, out var existing))
            return existing;

        var bare = _cache.ResolveDeploymentAsIChatClient(deployment);
        if (bare is null)
            return null;

        var instrumented = new InstrumentedChatClient(
            bare,
            gameKey,
            deployment,
            _loggerFactory.CreateLogger($"PoMiniGames.AI.{gameKey}"),
            _usage,
            _services.GetRequiredKeyedService<InferenceHealthTracker>(gameKey));

        var composed = new ResilientChatClient(
            instrumented,
            _pipelines.GetPipeline(AzureOpenAIResilience.PipelineName));

        return _composed.GetOrAdd(key, composed);
    }
}

/// <summary>DI registration for <see cref="GameChatClientFactory"/>-backed game chat clients.</summary>
public static class GameChatClientRegistration
{
    /// <summary>
    /// Adds the keyed <see cref="IChatClient"/> and per-game
    /// <see cref="InferenceHealthTracker"/> for <paramref name="gameKey"/>.
    /// </summary>
    public static IServiceCollection AddGameChatClient(this IServiceCollection services, string gameKey)
    {
        services.TryAddSingletonFactory();
        services.AddKeyedSingleton(gameKey, (_, _) => new InferenceHealthTracker());
        services.AddKeyedSingleton<IChatClient>(gameKey, (sp, key) =>
            sp.GetRequiredService<GameChatClientFactory>().ForGame((string)key!));
        return services;
    }

    private static void TryAddSingletonFactory(this IServiceCollection services)
        => Microsoft.Extensions.DependencyInjection.Extensions.ServiceCollectionDescriptorExtensions
            .TryAddSingleton<GameChatClientFactory>(services);
}
