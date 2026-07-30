namespace PoMiniGames.Features.PoSurvive;

using Microsoft.AspNetCore.Mvc;
using PoMiniGames.AI;
using PoMiniGames.Features.PoSurvive.Storage;
using PoShared.Simulation.Interfaces;
using PoShared.Simulation.Models;

/// <summary>
/// T076a: POST /api/infer — server-side relay that proxies inference requests to
/// AzureOpenAIInferenceService so the API key never reaches the browser.
/// Only active when Inference:UseCloudFallback = true.
/// Supports per-request model selection via <see cref="InferRequestDto.ModelId"/>
/// validated against the server-side allowlist.
/// Rate-limited to 10 req/s per IP via ASP.NET Core rate limiting.
/// </summary>
public static class InferEndpoints
{
    public static IEndpointRouteBuilder MapInferEndpoints(this IEndpointRouteBuilder routes, bool cloudFallbackEnabled)
    {
        // §1 NET_CLEAN_10: single-endpoint slices still use MapGroup so the
        // route prefix + OpenAPI tag + auth gate are declared once at the group
        // boundary (mirrors the convention in every other slice).
        var group = routes.MapGroup("/api/infer").WithTags("PoSurvive");

        // Status is mapped unconditionally — including when the relay is OFF, which is the
        // case it exists to report. The client used to have no way to ask, so it assumed
        // nothing was available and dropped straight into the local fallback table.
        group.MapGet("/status", GetStatus)
             .WithName("InferStatus")
             .WithSummary("Report whether the cloud inference relay is available, and which deployment serves it.")
             .Produces<InferenceStatusDto>(StatusCodes.Status200OK);

        if (cloudFallbackEnabled)
        {
            group.MapPost("", HandleAsync)
                 .WithName("Infer")
                 .WithSummary("Relay inference request to Azure OpenAI (cloud fallback only).")
                 .RequireRateLimiting("infer")
                 .Produces<InferenceResult>(StatusCodes.Status200OK)
                 .ProducesValidationProblem()
                 .ProducesProblem(StatusCodes.Status503ServiceUnavailable);
        }

        return routes;
    }

    /// <summary>
    /// Reports relay availability. Deliberately does NOT take <see cref="IInferenceService"/>
    /// as a parameter: that service is only registered when cloud fallback is on, and under
    /// the centralized-foundry path its factory throws when Key Vault has no AI config. A
    /// status probe that 500s on the exact configuration it is meant to describe is useless,
    /// so resolution is attempted defensively and a failure is reported as "unavailable".
    /// </summary>
    private static IResult GetStatus(IServiceProvider services, IConfiguration config)
    {
        var deployment = ResolveDeploymentName(config);

        if (!config.GetValue("Inference:UseCloudFallback", false))
            return Results.Ok(new InferenceStatusDto(Available: false, ModelId: deployment, Label: deployment));

        var available = false;
        try
        {
            available = services.GetService<IInferenceService>() is not null;
        }
        catch (Exception)
        {
            // Misconfigured foundry / missing Key Vault secrets. Not an error to surface —
            // it is precisely the answer the caller asked for.
            available = false;
        }

        return Results.Ok(new InferenceStatusDto(
            Available: available,
            ModelId: deployment,
            Label: available ? $"{deployment} (cloud)" : deployment));
    }

    /// <summary>
    /// The deployment that actually serves PoSurvive, preferring the centralized foundry's
    /// per-game allowlist over the legacy explicit setting.
    /// </summary>
    private static string ResolveDeploymentName(IConfiguration config)
        => config[$"{AIFoundryOptions.SectionName}:Deployments:{AIFoundryOptions.Games.Survive}"]
            ?? config["Inference:DeploymentName"]
            ?? "gpt-4o-mini";

    private static async Task<IResult> HandleAsync(
        [FromBody] InferRequestDto request,
        IInferenceService inferenceService,
        IConfiguration config,
        ILoggerFactory logFactory,
        CancellationToken ct)
    {
        var logger = logFactory.CreateLogger("InferEndpoints");

        if (!config.GetValue("Inference:UseCloudFallback", false))
            return Results.Problem(
                "Cloud inference fallback is disabled. Set Inference:UseCloudFallback=true to enable.",
                statusCode: StatusCodes.Status503ServiceUnavailable);

        if (string.IsNullOrWhiteSpace(request.GridJson) || request.GridJson.Length > 32_768)
            return Results.ValidationProblem(
                new Dictionary<string, string[]>
                {
                    ["gridJson"] = ["gridJson must be non-empty and ≤ 32 KB."]
                });

        try
        {
            InferenceResult result;

            // Use model-aware path when the service supports per-request deployment selection
            if (inferenceService is AzureOpenAIInferenceService azureSvc && !string.IsNullOrWhiteSpace(request.ModelId))
                result = await azureSvc.InferWithModelAsync(request.GridJson, request.Dna, request.ModelId, ct);
            else
                result = await inferenceService.InferAsync(request.GridJson, request.Dna, ct);

            logger.LogInformation("Infer completed. Model={ModelId} Action={Action}", request.ModelId ?? "default", result.Action);
            return Results.Ok(result);
        }
        catch (OperationCanceledException)
        {
            return Results.Problem("Inference timed out.", statusCode: StatusCodes.Status503ServiceUnavailable);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Inference error");
            return Results.Problem("Inference failed.", statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    }
}
