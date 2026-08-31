namespace PoMiniGames.Features.PoSurvive;

using System.Globalization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using PoMiniGames.AI;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.PoSurvive.Storage;
using PoMiniGames.Shared.Simulation.Interfaces;
using PoMiniGames.Shared.Simulation.Models;

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
    /// <para>
    /// It also reports the full allowlist, not just the default. <c>POST /api/infer</c> has
    /// accepted a per-request <c>ModelId</c> against <c>Inference:RemoteModelOptions</c> for as
    /// long as the map has existed, but status never mentioned the other ids, so the picker's
    /// cloud group could only ever hold one — on an account configured with three.
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
            Label: available ? $"{deployment} (cloud)" : deployment,
            Models: available ? ReadModelAllowlist(config, deployment) : null));
    }

    /// <summary>
    /// The ids a client may name, read from the same <c>Inference:RemoteModelOptions</c> section
    /// the relay validates against — one source, so the menu can never offer an id the relay
    /// would reject. The resolved default is always present and always first, even when the
    /// section omits it: it is the id every request that names nothing gets served by.
    /// </summary>
    private static List<InferenceModelDto> ReadModelAllowlist(IConfiguration config, string defaultDeployment)
    {
        var models = new List<InferenceModelDto>
        {
            new(defaultDeployment, $"{defaultDeployment} (default)"),
        };

        foreach (var child in config.GetSection("Inference:RemoteModelOptions").GetChildren())
        {
            var id = child["Id"];
            if (string.IsNullOrWhiteSpace(id))
                continue;
            if (models.Any(m => string.Equals(m.Id, id, StringComparison.OrdinalIgnoreCase)))
                continue;

            models.Add(new InferenceModelDto(id, child["Label"] ?? id));
        }

        return models;
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
        // Checked here as well as in BudgetedChatClient: refusing before the relay does any work
        // gives the caller a Retry-After and a clear 429, rather than surfacing as an exception
        // from inside the chat pipeline. The decorator is the guarantee; this is the good error.
        var identity = AiUsageScopeExtensions.ResolveIdentity(http);
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
        // Names the identity too, so the nested BudgetedChatClient charges the same ledger this
        // handler just checked rather than treating the call as unattributed.
        using var usage = AiUsageScope.Begin(identity);

        try
        {
            InferenceResult result;

            // Use model-aware path when the service supports per-request deployment selection
            if (inferenceService is AiInferenceRelayService azureSvc && !string.IsNullOrWhiteSpace(request.ModelId))
                result = await azureSvc.InferWithModelAsync(request.GridJson, request.Dna, request.ModelId, budget.Token);
            else
                result = await inferenceService.InferAsync(request.GridJson, request.Dna, budget.Token);

            // Charge ONLY what the decorator could not. BudgetedChatClient already recorded the
            // provider's reported usage for every call in this scope; recording it again here
            // would double-charge every caller. What remains is the case the decorator cannot
            // cover — a provider that reported no usage at all, which it records as zero — so the
            // deliberate over-estimate below is applied just to that.
            if (usage.TotalTokens <= 0)
                tokenBudget.Record(identity, EstimatedTokens(request, result));

            logger.LogInformation("Infer completed. Model={ModelId} Action={Action}", request.ModelId ?? "default", result.Action);
            return Results.Ok(result);
        }
        catch (AiTokenBudgetExceededException ex)
        {
            // The ceiling was reached by calls made inside this request, after the pre-check above
            // passed. Same answer as the pre-check, so a caller cannot tell the two apart.
            http.Response.Headers.RetryAfter = ex.RetryAfterSeconds.ToString(CultureInfo.InvariantCulture);
            return Results.Problem(ex.Message, statusCode: StatusCodes.Status429TooManyRequests);
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
    /// Fallback charge for a provider that reports no usage at all. The conventional
    /// ~4-chars-per-token estimate over what crossed the wire, plus the output ceiling — a
    /// deliberate over-estimate, because a ceiling that under-charges silent providers is not a
    /// ceiling. The normal path charges <see cref="AiUsageScope"/>'s reported figure instead.
    /// </summary>
    private static long EstimatedTokens(InferRequestDto request, InferenceResult result)
        => ((request.GridJson.Length + result.Thought.Length + result.Action.Length) / 4)
           + AiInferenceRelayService.MaxOutputTokens;
}
