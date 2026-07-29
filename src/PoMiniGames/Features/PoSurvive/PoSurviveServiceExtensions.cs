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
                services.AddSingleton<IInferenceService>(sp =>
                {
                    var chatClientCache = sp.GetRequiredService<AIFoundryChatClientCache>();
                    var chatClient = chatClientCache.ResolveAsIChatClient(AIFoundryOptions.Games.Survive)
                        ?? throw new InvalidOperationException(
                            $"PoSurvive: AIFoundry not configured. Set {AIFoundryOptions.SectionName} in Key Vault (kv-poshared).");

                    return new AzureOpenAIInferenceService(
                        chat: chatClient,
                        logger: sp.GetRequiredService<ILogger<AzureOpenAIInferenceService>>());
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

                var deploymentMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var child in configuration.GetSection("Inference:RemoteModelOptions").GetChildren())
                {
                    var id = child["Id"];
                    var deployment = child["DeploymentName"] ?? child["Id"];
                    if (!string.IsNullOrWhiteSpace(id) && !string.IsNullOrWhiteSpace(deployment))
                        deploymentMap[id!] = deployment!;
                }

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

    /// <summary>Maps PoSurvive minimal-API endpoints. /api/infer is mapped only when cloud fallback is enabled.</summary>
    public static IEndpointRouteBuilder MapPoSurviveEndpoints(this IEndpointRouteBuilder app, IConfiguration configuration)
    {
        app.MapEvolutionEndpoints();
        if (configuration.GetValue<bool>("Inference:UseCloudFallback"))
            app.MapInferEndpoints();

        return app;
    }
}
