using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;

namespace PoMiniGames.AI;

/// <summary>
/// Keeps the default deployment warm with one minimal model call every 30 minutes.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why.</b> The first model call after a cold period pays a connection-establishment and
/// model-warm-up penalty that the interactive games then surface as a slow first answer. A
/// periodic minimal call keeps the TLS session and the deployment's serving path hot, so a
/// player's first AI interaction costs the steady-state latency rather than the cold one.
/// </para>
/// <para>
/// <b>Cost.</b> One gpt-5-nano-class call per 30 minutes is ~48 calls/day at a few hundred
/// tokens each — a rounding error against the 250k/day per-identity ceiling, and it is charged
/// to no identity (the scope is deliberately anonymous: this is infrastructure spend, not a
/// player's).
/// </para>
/// <para>
/// <b>Failure posture.</b> Every failure is logged at Debug and swallowed. A warm-up ping that
/// cannot reach the deployment is exactly what the circuit breaker and health checks already
/// report; this service adds no second alarm channel. It also does not retry — the next tick
/// is the retry.
/// </para>
/// <para>
/// <b>Disabled when unconfigured.</b> If the foundry has no endpoint the service idles without
/// error, so local development (no Key Vault) is unaffected.
/// </para>
/// </remarks>
public sealed class AiWarmupService : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(30);

    private readonly GameChatClientFactory _clients;
    private readonly IOptionsMonitor<AIFoundryOptions> _options;
    private readonly ILogger<AiWarmupService> _logger;

    public AiWarmupService(
        GameChatClientFactory clients,
        IOptionsMonitor<AIFoundryOptions> options,
        ILogger<AiWarmupService> logger)
    {
        _clients = clients;
        _options = options;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // First ping after a short settle delay so host startup (storage init, deployment
        // validation) is not contending with it.
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(20), stoppingToken);
        }
        catch (OperationCanceledException) { return; }

        while (!stoppingToken.IsCancellationRequested)
        {
            await PingOnce(stoppingToken);

            try
            {
                await Task.Delay(Interval, stoppingToken);
            }
            catch (OperationCanceledException) { return; }
        }
    }

    private async Task PingOnce(CancellationToken stoppingToken)
    {
        var options = _options.CurrentValue;
        if (!options.IsConfigured)
            return;

        var deployment = options.ResolveDeployment(AIFoundryOptions.Games.Survive);
        try
        {
            var chat = _clients.ForDeployment(AIFoundryOptions.Games.Survive, deployment);
            if (chat is null)
                return;

            var messages = new List<ChatMessage>
            {
                new(ChatRole.System, "Reply with the single word: ready."),
                new(ChatRole.User, "warmup"),
            };

            // Minimal output ceiling — this is a liveness ping, not a conversation.
            var chatOptions = AiDecisionChatOptions.ForBoundedText(
                maxOutputTokens: 8,
                deployment: deployment,
                capabilityOverrides: options.ModelCapabilityOverrides);

            var started = System.Diagnostics.Stopwatch.GetTimestamp();
            var response = await chat.GetResponseAsync(messages, chatOptions, stoppingToken);
            var elapsedMs = (long)System.Diagnostics.Stopwatch.GetElapsedTime(started).TotalMilliseconds;

            _logger.AiWarmupPing(deployment, elapsedMs, response.Text?.Length ?? 0);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Shutdown — not an error.
        }
        catch (Exception ex)
        {
            // Swallowed by design: the health checks and circuit breaker already report
            // deployment state. This service adds no second alarm channel.
            _logger.AiWarmupFailed(deployment, ex.GetType().Name, ex.Message);
        }
    }
}

public static partial class AiWarmupLog
{
    [LoggerMessage(EventId = 1, Level = LogLevel.Debug,
        Message = "AI warm-up ping to {Deployment} succeeded in {ElapsedMs} ms (reply {ReplyLength} chars).")]
    public static partial void AiWarmupPing(this ILogger logger, string deployment, long elapsedMs, int replyLength);

    [LoggerMessage(EventId = 2, Level = LogLevel.Debug,
        Message = "AI warm-up ping to {Deployment} failed ({ExceptionType}): {Message}")]
    public static partial void AiWarmupFailed(this ILogger logger, string deployment, string exceptionType, string message);
}
