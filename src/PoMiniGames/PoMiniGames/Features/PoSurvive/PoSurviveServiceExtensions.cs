using Azure;
using Azure.AI.OpenAI;
using PoSurvive.Application.Interfaces;
using PoSurvive.Application.Services;
using PoSurvive.Infrastructure.AI;
using PoSurvive.Infrastructure.Persistence.TableStorage;
using PoSurvive.Server.Endpoints;
using PoSurvive.Shared.Interfaces;

namespace PoMiniGames.Features.PoSurvive;

/// <summary>
/// Registers PoSurvive (agent survival simulation) server-side services and endpoints.
/// Persistence (sessions + evolution) always registers; the Azure OpenAI inference relay
/// is gated behind Inference:UseCloudFallback so the API key never reaches the browser.
/// The "infer" rate-limiter policy is registered centrally in <see cref="Infrastructure.RateLimitingExtensions"/>.
/// </summary>
public static class PoSurviveServiceExtensions
{
    public static IServiceCollection AddPoSurvive(this IServiceCollection services, IConfiguration configuration)
    {
        // ─── Persistence (Azure Table Storage; own tables, separate from PoMiniGames stats) ───
        services.AddSingleton<ISessionRepository, SessionRepository>();
        services.AddSingleton<IEvolutionRepository, EvolutionRepository>();
        services.AddSingleton<EvolutionEngine>();

        // ─── Azure OpenAI inference relay (server-side only) ───────────────────
        if (configuration.GetValue<bool>("Inference:UseCloudFallback"))
        {
            var endpoint = configuration["Inference:Endpoint"]
                ?? throw new InvalidOperationException("Inference:Endpoint must be set when Inference:UseCloudFallback=true");
            var defaultDeployment = configuration["Inference:DeploymentName"] ?? "gpt-5.4-nano";
            var apiKey = configuration["Inference:ApiKey"]
                ?? throw new InvalidOperationException("Inference:ApiKey must be set when Inference:UseCloudFallback=true");

            // Allowlist: modelId → deploymentName from Inference:RemoteModelOptions
            var deploymentMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var child in configuration.GetSection("Inference:RemoteModelOptions").GetChildren())
            {
                var id = child["Id"];
                var deployment = child["DeploymentName"] ?? child["Id"];
                if (!string.IsNullOrWhiteSpace(id) && !string.IsNullOrWhiteSpace(deployment))
                    deploymentMap[id!] = deployment!;
            }

            services.AddSingleton(_ => new AzureOpenAIClient(new Uri(endpoint), new AzureKeyCredential(apiKey)));
            services.AddSingleton<IInferenceService>(sp =>
                new AzureOpenAIInferenceService(
                    openAiClient: sp.GetRequiredService<AzureOpenAIClient>(),
                    defaultDeployment: defaultDeployment,
                    deploymentMap: deploymentMap));
        }

        return services;
    }

    /// <summary>Maps PoSurvive minimal-API endpoints. /api/infer is mapped only when cloud fallback is enabled.</summary>
    public static IEndpointRouteBuilder MapPoSurviveEndpoints(this IEndpointRouteBuilder app, IConfiguration configuration)
    {
        app.MapSessionEndpoints();
        app.MapEvolutionEndpoints();
        if (configuration.GetValue<bool>("Inference:UseCloudFallback"))
            app.MapInferEndpoints();

        return app;
    }
}
