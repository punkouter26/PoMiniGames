using System.Diagnostics;
using Microsoft.Extensions.AI;

namespace PoMiniGames.AI;

/// <summary>
/// Records token usage and latency for every model call, and reports the outcome to a
/// per-game <see cref="PoMiniGames.Shared.Simulation.Models.InferenceHealthTracker"/>.
/// </summary>
/// <remarks>
/// <para>
/// <c>ChatResponse.Usage</c> was discarded at every call site in the solution, so there was no
/// way to answer "what does a match cost?", no per-deployment latency signal, and — the reason
/// this matters most — no record that a deployment had stopped answering. A live 75-second
/// PoSurvive session issued 15 relay calls and completed none of them without producing a single
/// aggregate anyone could look at afterwards.
/// </para>
/// <para>
/// GoF: Decorator, sitting inside <see cref="ResilientChatClient"/> so what it times is one
/// attempt's real service latency rather than the retry envelope.
/// </para>
/// </remarks>
public sealed class InstrumentedChatClient : DelegatingChatClient
{
    private readonly string _game;
    private readonly string _deployment;
    private readonly ILogger _logger;
    private readonly AiUsageAccumulator _usage;
    private readonly PoMiniGames.Shared.Simulation.Models.InferenceHealthTracker _health;

    public InstrumentedChatClient(
        IChatClient innerClient,
        string game,
        string deployment,
        ILogger logger,
        AiUsageAccumulator usage,
        PoMiniGames.Shared.Simulation.Models.InferenceHealthTracker health)
        : base(innerClient)
    {
        _game = game;
        _deployment = deployment;
        _logger = logger;
        _usage = usage;
        _health = health;
    }

    public override async Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        var started = Stopwatch.GetTimestamp();
        try
        {
            var response = await base.GetResponseAsync(messages, options, cancellationToken);
            var elapsedMs = (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds;

            var usage = response.Usage;
            _logger.AiCallCompleted(
                _game, _deployment,
                usage?.InputTokenCount ?? 0,
                usage?.OutputTokenCount ?? 0,
                usage?.TotalTokenCount ?? 0,
                elapsedMs);

            _usage.Record(_game, _deployment, usage?.TotalTokenCount ?? 0, elapsedMs);
            // Charges the caller's per-identity allowance with what the provider actually billed,
            // when a request handler has opened a scope for it.
            AiUsageScope.Report(usage?.TotalTokenCount ?? 0);
            _health.RecordSuccess();
            return response;
        }
        catch (Exception ex)
        {
            var elapsedMs = (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds;
            _logger.AiCallFailed(_game, _deployment, elapsedMs, ex.GetType().Name, ex);
            _usage.RecordFailure(_game, _deployment, elapsedMs);
            _health.RecordFailure();
            throw;
        }
    }
}
