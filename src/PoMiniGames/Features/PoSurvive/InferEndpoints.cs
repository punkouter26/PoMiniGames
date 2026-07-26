namespace PoMiniGames.Features.PoSurvive.Endpoints;

using Microsoft.AspNetCore.Mvc;
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
    public static IEndpointRouteBuilder MapInferEndpoints(this IEndpointRouteBuilder routes)
    {
        // §1 NET_CLEAN_10: single-endpoint slices still use MapGroup so the
        // route prefix + OpenAPI tag + auth gate are declared once at the group
        // boundary (mirrors the convention in every other slice).
        var group = routes.MapGroup("/api/infer").WithTags("PoSurvive");

        group.MapPost("", HandleAsync)
             .WithName("Infer")
             .WithSummary("Relay inference request to Azure OpenAI (cloud fallback only).")
             .RequireRateLimiting("infer")
             .Produces<InferenceResult>(StatusCodes.Status200OK)
             .ProducesValidationProblem()
             .ProducesProblem(StatusCodes.Status503ServiceUnavailable);

        return routes;
    }

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
