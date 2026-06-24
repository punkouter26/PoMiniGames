using System.ClientModel.Primitives;
using Azure.AI.OpenAI;

namespace PoMiniGames.Infrastructure.AI;

/// <summary>
/// Centralises the resilience posture for every Azure OpenAI client in the solution so no
/// call path can be constructed that assumes the service is always up and infinitely fast.
/// </summary>
/// <remarks>
/// The Azure OpenAI SDK (System.ClientModel pipeline) retries transient failures by default;
/// what it does <i>not</i> do out of the box is bound a single attempt, so a half-open
/// connection can hang a request indefinitely. We pin a per-attempt network timeout and an
/// explicit retry count so the worst case is bounded and observable.
/// </remarks>
public static class AzureOpenAIResilience
{
    /// <summary>Per-attempt network timeout. Real-time games cannot wait longer than this.</summary>
    public static readonly TimeSpan NetworkTimeout = TimeSpan.FromSeconds(30);

    /// <summary>Transient-failure retry attempts (in addition to the initial try).</summary>
    public const int MaxRetries = 3;

    /// <summary>Client options with a bounded per-attempt timeout and explicit retry count.</summary>
    public static AzureOpenAIClientOptions DefaultOptions()
    {
        var options = new AzureOpenAIClientOptions
        {
            NetworkTimeout = NetworkTimeout,
            RetryPolicy = new ClientRetryPolicy(MaxRetries),
        };
        return options;
    }
}
