using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Polly.Registry;
using PoShared.Simulation.Models;

namespace PoMiniGames.AI;

/// <summary>
/// Registers one composed <see cref="IChatClient"/> per game, keyed by game key, wrapping the
/// shared foundry client in the resilience and telemetry decorators.
/// </summary>
/// <remarks>
/// <para>
/// Each AI-consuming slice previously reached into <see cref="AIFoundryChatClientCache"/> itself
/// and used the bare client. That left every cross-cutting guarantee opt-in, and every slice
/// opted out: the resilience pipeline had no consumers at all, and no call site recorded token
/// usage. Composing here means a slice gets the whole posture by asking DI for its chat client:
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
/// </remarks>
public static class GameChatClientRegistration
{
    /// <summary>
    /// Adds the keyed <see cref="IChatClient"/> and per-game
    /// <see cref="InferenceHealthTracker"/> for <paramref name="gameKey"/>.
    /// Resolving the client throws when the foundry is unconfigured — callers that have a mock
    /// path must check <see cref="AIFoundryOptions.IsConfigured"/> first rather than catching.
    /// </summary>
    public static IServiceCollection AddGameChatClient(this IServiceCollection services, string gameKey)
    {
        services.AddKeyedSingleton(gameKey, (_, _) => new InferenceHealthTracker());

        services.AddKeyedSingleton<IChatClient>(gameKey, (sp, key) =>
        {
            var game = (string)key!;
            var cache = sp.GetRequiredService<AIFoundryChatClientCache>();
            var options = sp.GetRequiredService<IOptionsMonitor<AIFoundryOptions>>().CurrentValue;
            var deployment = options.ResolveDeployment(game);

            var bare = cache.ResolveAsIChatClient(game)
                ?? throw new InvalidOperationException(
                    $"AIFoundry is not configured for game '{game}'. Set {AIFoundryOptions.SectionName} " +
                    "(FoundryEndpoint + DefaultDeployment) in Key Vault (kv-poshared) or configuration.");

            var instrumented = new InstrumentedChatClient(
                bare,
                game,
                deployment,
                sp.GetRequiredService<ILoggerFactory>().CreateLogger($"PoMiniGames.AI.{game}"),
                sp.GetRequiredService<AiUsageAccumulator>(),
                sp.GetRequiredKeyedService<InferenceHealthTracker>(game));

            var pipeline = sp.GetRequiredService<ResiliencePipelineProvider<string>>()
                .GetPipeline(AzureOpenAIResilience.PipelineName);

            return new ResilientChatClient(instrumented, pipeline);
        });

        return services;
    }
}
