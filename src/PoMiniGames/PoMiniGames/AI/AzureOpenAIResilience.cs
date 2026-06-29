using System.ClientModel.Primitives;
using Azure.AI.OpenAI;
using Microsoft.Extensions.DependencyInjection;
using Polly;
using Polly.CircuitBreaker;
using Polly.Retry;
using Polly.Timeout;

namespace PoMiniGames.AI;

/// <summary>
/// Centralises the resilience posture for every Azure OpenAI client in the solution so no
/// call path can be constructed that assumes the service is always up and infinitely fast.
/// </summary>
/// <remarks>
/// <para>
/// §3 chaos-engineering hardening: the original implementation set only a per-attempt
/// network timeout and a flat retry count. With no circuit breaker, a single hung Azure
/// region could saturate the request pipeline (30s × unbounded concurrent callers) and
/// starve the rest of the app. The new pipeline adds three guards:
/// <list type="number">
///   <item><b>Outer timeout</b> (per call, including all retries) — the worst case the
///         caller ever observes.</item>
///   <item><b>Retry with exponential backoff + jitter</b> — same transient-fault coverage
///         as before, but on a backoff that doesn't synchronise storm retries.</item>
///   <item><b>Circuit breaker</b> — after 30 % failures across 10 requests in 30 s, the
///         pipeline short-circuits for 15 s and returns <c>BrokenCircuitException</c>
///         immediately rather than queuing 30-second timeouts against a dead endpoint.</item>
/// </list>
/// </para>
/// <para>
/// The Azure OpenAI SDK (System.ClientModel) keeps its own <see cref="ClientRetryPolicy"/>
/// for the underlying transport, but the orchestrating <see cref="ResiliencePipeline"/>
/// is now the source of truth for total-call budget and circuit state.
/// </para>
/// <para>
/// <b>Namespace consolidation.</b> Previously lived under
/// <c>PoMiniGames.Infrastructure.AI</c> alongside the rest of the centralization types.
/// Moved here as part of the migration-window cleanup so every AI consumer compiles
/// against a single <c>using PoMiniGames.AI;</c> (wired by the host's
/// <c>GlobalUsings.cs</c>).
/// </para>
/// </remarks>
public static class AzureOpenAIResilience
{
    /// <summary>Pipeline name registered with <see cref="ResiliencePipelineProvider{TKey}"/>.</summary>
    public const string PipelineName = "ai-foundry";

    /// <summary>Per-attempt network timeout (set on the SDK client options).</summary>
    public static readonly TimeSpan NetworkTimeout = TimeSpan.FromSeconds(15);

    /// <summary>Per-call outer timeout — includes all retries. Real-time games cannot wait longer than this.</summary>
    public static readonly TimeSpan TotalCallBudget = TimeSpan.FromSeconds(20);

    /// <summary>Transient-failure retry attempts (in addition to the initial try) at the SDK layer.</summary>
    public const int MaxSdkRetries = 2;

    /// <summary>
    /// Registers the resilience pipeline used by every AI Foundry call. Called once from
    /// <c>GameServicesExtensions.AddPoMiniGamesGameServices</c>; consumers retrieve it
    /// from <see cref="ResiliencePipelineProvider{TKey}"/>.
    /// </summary>
    public static IServiceCollection AddAzureOpenAIResilience(this IServiceCollection services)
    {
        services.AddResiliencePipeline(PipelineName, builder =>
        {
            builder.AddTimeout(new TimeoutStrategyOptions
            {
                Timeout = TotalCallBudget,
            });
            builder.AddRetry(new RetryStrategyOptions
            {
                MaxRetryAttempts = 3,
                Delay = TimeSpan.FromMilliseconds(200),
                MaxDelay = TimeSpan.FromSeconds(2),
                BackoffType = DelayBackoffType.Exponential,
                UseJitter = true,
                ShouldHandle = new PredicateBuilder().Handle<Exception>(IsTransient),
            });
            builder.AddCircuitBreaker(new CircuitBreakerStrategyOptions
            {
                FailureRatio = 0.3,
                MinimumThroughput = 10,
                SamplingDuration = TimeSpan.FromSeconds(30),
                BreakDuration = TimeSpan.FromSeconds(15),
                ShouldHandle = new PredicateBuilder().Handle<Exception>(IsTransient),
            });
        });
        return services;
    }

    /// <summary>Client options with a bounded per-attempt timeout and explicit retry count.</summary>
    public static AzureOpenAIClientOptions DefaultOptions() => new()
    {
        NetworkTimeout = NetworkTimeout,
        RetryPolicy = new ClientRetryPolicy(MaxSdkRetries),
    };

    /// <summary>
    /// True when the exception is one we should retry or trip the breaker on. Non-transient
    /// faults (validation, auth) bubble straight out so the caller sees the real reason.
    /// </summary>
    private static bool IsTransient(Exception ex) => ex switch
    {
        TimeoutRejectedException                 => true,
        BrokenCircuitException                   => true,
        Azure.RequestFailedException rfe         => rfe.Status >= 500 || rfe.Status == 408 || rfe.Status == 429,
        HttpRequestException                     => true,
        TaskCanceledException                    => false, // user-initiated; not a transient fault
        _                                        => false,
    };
}
