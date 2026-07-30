using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;
using PoMiniGames.Application.Simulation;
using PoMiniGames.Features.PoSurvive.Storage;
using PoShared.Simulation.Interfaces;

namespace PoMiniGames.Features.PoSurvive;

/// <summary>
/// Registers PoSurvive (agent survival simulation) server-side services and endpoints.
/// Persistence (sessions + evolution) always registers; the Azure OpenAI inference relay
/// is gated behind <c>Inference:UseCloudFallback</c> and routes through the centralized
/// Azure AI Foundry hub in the <c>PoShared</c> resource group.
/// </summary>
public static class PoSurviveServiceExtensions
{
    public static IServiceCollection AddPoSurvive(this IServiceCollection services, IConfiguration configuration)
    {
        // ─── Persistence (Azure Table Storage; own tables, separate from PoMiniGames stats) ───
        services.AddSingleton<IEvolutionRepository, EvolutionRepository>();
        services.AddSingleton<EvolutionEngine>();

        // ─── Azure OpenAI inference relay (server-side only) ───────────────────
        if (configuration.GetValue<bool>("Inference:UseCloudFallback"))
        {
            var useFoundry = configuration.GetValue<bool>("Inference:UseCentralizedFoundry", defaultValue: true);

            if (useFoundry)
            {
                // Recommended path: shared AIFoundryClientFactory in PoShared RG.
                // No API key required (AAD bearer via DefaultAzureCredential on the
                // Web App's system-assigned MI). The PoSurvive deployment is
                // resolved through AIFoundryOptions.Deployments["survive"].
                //
                // The chat client comes from the keyed registration rather than straight out of
                // AIFoundryChatClientCache, which is what puts the resilience pipeline and the
                // usage/health telemetry in the call path — both were previously bypassed
                // entirely (the pipeline had no consumers at all).
                services.AddGameChatClient(AIFoundryOptions.Games.Survive);

                services.AddSingleton<IInferenceService>(sp =>
                {
                    var chatClient = sp.GetRequiredKeyedService<IChatClient>(AIFoundryOptions.Games.Survive);

                    // Per-request model selection: only ids on this allowlist may pick a
                    // deployment, and each resolves to its own cached client. The relay used to
                    // advertise this on /api/infer and then serve every request from the default
                    // deployment regardless.
                    //
                    // Resolved through GameChatClientFactory, NOT the bare cache: the selected
                    // deployment's client must carry the same resilience and telemetry decorators
                    // as the game's default one. Going to the cache directly silently opted every
                    // model-selecting call — i.e. all of them — out of both.
                    var deploymentMap = ReadRemoteModelAllowlist(configuration);
                    var clients = sp.GetRequiredService<GameChatClientFactory>();

                    return new AzureOpenAIInferenceService(
                        chat: chatClient,
                        deploymentMap: deploymentMap,
                        logger: sp.GetRequiredService<ILogger<AzureOpenAIInferenceService>>(),
                        clientForDeployment: d => clients.ForDeployment(AIFoundryOptions.Games.Survive, d));
                });
            }
            else
            {
                // Legacy path: explicit endpoint + api-key. Retained for dev environments
                // that want to point PoSurvive at a personal Azure OpenAI resource without
                // going through the shared foundry. Throw on misconfiguration so a
                // production deployment can never silently no-op.
                var endpoint = configuration["Inference:Endpoint"]
                    ?? throw new InvalidOperationException("Inference:Endpoint must be set when Inference:UseCloudFallback=true");
                var defaultDeployment = configuration["Inference:DeploymentName"] ?? "gpt-4o-mini";
                var apiKey = configuration["Inference:ApiKey"]
                    ?? throw new InvalidOperationException("Inference:ApiKey must be set when Inference:UseCloudFallback=true");

                var deploymentMap = ReadRemoteModelAllowlist(configuration);

                services.AddSingleton(_ => new Azure.AI.OpenAI.AzureOpenAIClient(
                    new Uri(endpoint),
                    new Azure.AzureKeyCredential(apiKey),
                    AzureOpenAIResilience.DefaultOptions()));

                services.AddSingleton<IInferenceService>(sp =>
                {
                    var azure = sp.GetRequiredService<Azure.AI.OpenAI.AzureOpenAIClient>()
                        .GetChatClient(defaultDeployment)
                        .AsIChatClient();
                    return new AzureOpenAIInferenceService(
                        chat: azure,
                        deploymentMap: deploymentMap,
                        logger: sp.GetRequiredService<ILogger<AzureOpenAIInferenceService>>());
                });
            }
        }

        return services;
    }

    /// <summary>
    /// The server-side allowlist of model ids a client may name in <c>InferRequestDto.ModelId</c>,
    /// mapped to the deployment that serves each. Read from <c>Inference:RemoteModelOptions</c>;
    /// an id absent from it falls back to the game's default deployment rather than being
    /// forwarded, so a caller can never address an arbitrary deployment.
    /// </summary>
    private static Dictionary<string, string> ReadRemoteModelAllowlist(IConfiguration configuration)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var child in configuration.GetSection("Inference:RemoteModelOptions").GetChildren())
        {
            var id = child["Id"];
            var deployment = child["DeploymentName"] ?? child["Id"];
            if (!string.IsNullOrWhiteSpace(id) && !string.IsNullOrWhiteSpace(deployment))
                map[id!] = deployment!;
        }
        return map;
    }

    /// <summary>Maps PoSurvive minimal-API endpoints. /api/infer is mapped only when cloud fallback is enabled.</summary>
    public static IEndpointRouteBuilder MapPoSurviveEndpoints(this IEndpointRouteBuilder app, IConfiguration configuration)
    {
        app.MapEvolutionEndpoints();

        // Always mapped now. /api/infer/status has to answer "the relay is off" as well as
        // "it is on" — skipping the whole group when cloud fallback was disabled left the
        // client with a 404 it could not distinguish from a routing mistake, so it never
        // asked, and always assumed the worst.
        app.MapInferEndpoints(configuration.GetValue<bool>("Inference:UseCloudFallback"));

        return app;
    }
}
