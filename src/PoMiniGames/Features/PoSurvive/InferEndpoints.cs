namespace PoMiniGames.Features.PoSurvive;

using System.Globalization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using PoMiniGames.AI;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.PoSurvive.Storage;
using PoShared.Simulation.Interfaces;
using PoShared.Simulation.Models;

/// <summary>
/// T076a: POST /api/infer — server-side relay that proxies inference requests to
/// AzureOpenAIInferenceService so the API key never reaches the browser.
/// Only active when Inference:UseCloudFallback = true.
/// Supports per-request model selection via <see cref="InferRequestDto.ModelId"/>
/// validated against the server-side allowlist.
/// Rate-limited to 10 req/s per IP via ASP.NET Core rate limiting, and bounded in total
/// spend by <see cref="AiTokenBudget"/>.
/// </summary>
public static class InferEndpoints
{
    /// <summary>
    /// Ceiling on one relay call, including retries. Must stay BELOW the client's per-agent
    /// budget (<c>Inference:InferenceTimeoutMs</c>, 15 s) — see <see cref="ResolveServerBudget"/>.
    /// </summary>
    public const int DefaultServerBudgetMs = 9_000;

    /// <summary>nginx's 499 — "caller hung up". Not present in <see cref="StatusCodes"/>.</summary>
    private const int ClientClosedRequest = 499;

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
                 .ProducesProblem(StatusCodes.Status429TooManyRequests)
                 .ProducesProblem(StatusCodes.Status502BadGateway)
                 .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
                 .ProducesProblem(StatusCodes.Status504GatewayTimeout);
        }

        return routes;
    }

    /// <summary>
    /// Reports relay availability and the deployment that serves it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Deliberately does NOT take <see cref="IInferenceService"/> as a parameter: that service is
    /// only registered when cloud fallback is on, and its factory throws when the foundry has no
    /// AI config. A status probe that 500s on the exact configuration it is meant to describe is
    /// useless, so resolution is attempted defensively and a failure is reported as "unavailable".
    /// </para>
    /// <para>
    /// The deployment name comes from <see cref="AIFoundryOptions.ResolveDeployment"/> — the same
    /// call the chat client is built from. It used to read raw configuration keys instead, and the
    /// two resolvers disagreed in production: status advertised <c>gpt-4o-mini</c> (a deployment
    /// that did not exist on the account) while calls went to the Key Vault default.
    /// </para>
    /// </remarks>
    private static IResult GetStatus(
        IServiceProvider services,
        IConfiguration config,
        IOptionsMonitor<AIFoundryOptions> aiOptions)
    {
        var deployment = aiOptions.CurrentValue.ResolveDeployment(AIFoundryOptions.Games.Survive);

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
    /// The relay's own deadline. The caller (one agent's turn slice in the browser) abandons the
    /// request at <c>Inference:InferenceTimeoutMs</c>; a measured relay call nonetheless held a
    /// connection and kept spending tokens for 51.6 s producing an answer nobody would read.
    /// Failing first is what makes the work bounded.
    /// </summary>
    private static int ResolveServerBudget(IConfiguration config)
        => Math.Clamp(config.GetValue("Inference:ServerBudgetMs", DefaultServerBudgetMs), 250, 30_000);

    private static async Task<IResult> HandleAsync(
        [FromBody] InferRequestDto request,
        HttpContext http,
        IInferenceService inferenceService,
        IConfiguration config,
        AiTokenBudget tokenBudget,
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

        // ── Cost ceiling ──────────────────────────────────────────────────────
        var identity = ResolveBudgetIdentity(http);
        var verdict = tokenBudget.Check(identity);
        if (!verdict.Allowed)
        {
            logger.TokenBudgetExhausted(identity, verdict.Spent, verdict.Limit, verdict.ResetUtc);
            var retryAfterSeconds = Math.Max(1, (int)(verdict.ResetUtc - DateTimeOffset.UtcNow).TotalSeconds);
            http.Response.Headers.RetryAfter = retryAfterSeconds.ToString(CultureInfo.InvariantCulture);
            return Results.Problem(
                $"Daily AI token allowance spent ({verdict.Spent}/{verdict.Limit}). Resets at {verdict.ResetUtc:O}.",
                statusCode: StatusCodes.Status429TooManyRequests);
        }

        // The caller's cancellation still wins; this only ensures the server never outlives it.
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(ResolveServerBudget(config));

        // Collects the provider's own usage report so the allowance is charged what was billed.
        using var usage = AiUsageScope.Begin();

        try
        {
            InferenceResult result;

            // Use model-aware path when the service supports per-request deployment selection
            if (inferenceService is AzureOpenAIInferenceService azureSvc && !string.IsNullOrWhiteSpace(request.ModelId))
                result = await azureSvc.InferWithModelAsync(request.GridJson, request.Dna, request.ModelId, budget.Token);
            else
                result = await inferenceService.InferAsync(request.GridJson, request.Dna, budget.Token);

            tokenBudget.Record(identity, usage.TotalTokens > 0 ? usage.TotalTokens : EstimatedTokens(request, result));
            logger.LogInformation("Infer completed. Model={ModelId} Action={Action}", request.ModelId ?? "default", result.Action);
            return Results.Ok(result);
        }
        catch (InferenceResponseUnusableException ex)
        {
            // The provider answered, but with nothing a game can act on. 502 rather than a 200
            // carrying a fabricated "Idle": the client must be able to count this as a failure.
            logger.LogWarning(ex, "Inference produced no usable decision");
            return Results.Problem(
                "The model returned no usable decision.",
                statusCode: StatusCodes.Status502BadGateway);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // Our budget expired, not the caller's. Distinct status so the client can tell
            // "the model is too slow" from "the relay is switched off".
            return Results.Problem(
                $"Inference exceeded the server budget of {ResolveServerBudget(config)} ms.",
                statusCode: StatusCodes.Status504GatewayTimeout);
        }
        catch (OperationCanceledException)
        {
            // The browser gave up first; nothing to report to a listener that has gone away.
            return Results.Problem("Inference cancelled by the caller.", statusCode: ClientClosedRequest);
        }
        catch (System.ClientModel.ClientResultException ex) when (ex.Status == StatusCodes.Status429TooManyRequests)
        {
            // The provider is throttling us, which is a different thing from the relay being
            // broken and a different thing again from the caller exhausting their own allowance.
            // Reported distinctly so the log, the client and the health tracker can tell a quota
            // ceiling (an Azure-side setting) from a fault (something to fix here).
            var retryAfter = ex.GetRawResponse()?.Headers.TryGetValue("retry-after", out var value) == true
                ? value
                : "30";
            http.Response.Headers.RetryAfter = retryAfter;
            logger.LogWarning(
                "Inference throttled by the provider (retry-after={RetryAfter}s). The deployment's request quota is the limit, not this host.",
                retryAfter);
            return Results.Problem(
                "The model deployment is rate-limited right now.",
                statusCode: StatusCodes.Status429TooManyRequests);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Inference error");
            return Results.Problem("Inference failed.", statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    }

    /// <summary>
    /// Budget key: the signed-in identity, falling back to the remote address so an anonymous or
    /// guest caller still cannot spend without limit.
    /// </summary>
    private static string ResolveBudgetIdentity(HttpContext http)
    {
        var identity = RequestIdentity.Resolve(http.User);
        return !string.IsNullOrEmpty(identity.UserId)
            ? $"id:{identity.UserId}"
            : $"ip:{http.Connection.RemoteIpAddress?.ToString() ?? "unknown"}";
    }

    /// <summary>
    /// Fallback charge for a provider that reports no usage at all. The conventional
    /// ~4-chars-per-token estimate over what crossed the wire, plus the output ceiling — a
    /// deliberate over-estimate, because a ceiling that under-charges silent providers is not a
    /// ceiling. The normal path charges <see cref="AiUsageScope"/>'s reported figure instead.
    /// </summary>
    private static long EstimatedTokens(InferRequestDto request, InferenceResult result)
        => ((request.GridJson.Length + result.Thought.Length + result.Action.Length) / 4)
           + AzureOpenAIInferenceService.MaxOutputTokens;
}
