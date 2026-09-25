using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading.RateLimiting;
using Microsoft.Extensions.Options;

namespace PoMiniGames.Features.PoJevArena.Jev;

/// <summary>Jev's validated answers for one unit.</summary>
public sealed record JevAnswers(
    string Action,
    double ActionConfidence,
    Dictionary<string, double> ActionProbabilities,
    string? Focus,
    double FocusConfidence,
    Dictionary<string, double>? FocusProbabilities,
    double Panic);

public sealed record JevUsage(long InputTokens, long OutputTokens, double CostUsd);

/// <summary>
/// One evaluation: answers on success, or a stable failure code (<c>not-configured</c>, <c>busy</c>,
/// <c>timeout</c>, <c>http-{status}</c>, <c>malformed</c>, <c>unknown-option</c>,
/// <c>bad-probability</c>, <c>network</c>). A failure means the unit holds its last intent.
/// </summary>
public sealed record JevOutcome(bool Ok, string? Failure, JevAnswers? Answers, JevUsage? Usage, int LatencyMs)
{
    public static JevOutcome Fail(string failure, int latencyMs = 0) => new(false, failure, null, null, latencyMs);
}

/// <summary>The Jev boundary. One call evaluates one unit's three questions.</summary>
public interface IJevClient
{
    bool IsConfigured { get; }

    Task<JevOutcome> EvaluateAsync(JevPrompt prompt, string sessionId, string user, CancellationToken ct = default);
}

/// <summary>
/// The one process-wide in-flight cap in front of Jev. A singleton, so every typed-client instance
/// shares it — a limiter per client instance would multiply the permits exactly the way the
/// per-pipeline AI limiters once did (see <c>AiConcurrencyGate</c>).
/// </summary>
public sealed class JevConcurrencyGate(IOptions<JevOptions> options) : IDisposable
{
    public ConcurrencyLimiter Limiter { get; } = new(new ConcurrencyLimiterOptions
    {
        PermitLimit = Math.Max(1, options.Value.MaxConcurrentCalls),
        QueueLimit = Math.Max(1, options.Value.MaxConcurrentCalls) * 4,
        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
    });

    public void Dispose() => Limiter.Dispose();
}

/// <summary>
/// HTTP client for OpenRouter's System One endpoint. Deliberately has no retry pipeline: units
/// re-decide every second, so a late or retried answer is worth less than holding the last one,
/// and the per-call timeout below is the whole resilience story. Never throws for upstream
/// failure — every path returns a <see cref="JevOutcome"/>.
/// </summary>
public sealed class JevClient(
    HttpClient http,
    IOptions<JevOptions> options,
    JevConcurrencyGate gate,
    ILogger<JevClient> logger) : IJevClient
{
    public const string HttpClientName = "jev";

    private readonly JevOptions _options = options.Value;

    public bool IsConfigured => _options.IsConfigured;

    public async Task<JevOutcome> EvaluateAsync(JevPrompt prompt, string sessionId, string user, CancellationToken ct = default)
    {
        if (!IsConfigured) return JevOutcome.Fail("not-configured");

        var questions = prompt.Questions.ToDictionary(
            q => q.Key, q => new JevWireQuestion(q.Value.Type, q.Value.Instructions, q.Value.Criteria), StringComparer.Ordinal);
        var body = new JevWireRequest(_options.Model, prompt.State, questions, sessionId, user);

        // The budget starts before the queue: time spent waiting for a concurrency slot counts,
        // because an answer that lands after the unit's next 1 Hz slot is worthless either way.
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromMilliseconds(Math.Max(1, _options.CallTimeoutMs)));
        var clock = Stopwatch.StartNew();

        try
        {
            using var lease = await gate.Limiter.AcquireAsync(1, timeout.Token);
            if (!lease.IsAcquired) return JevOutcome.Fail("busy", Elapsed(clock));

            using var request = new HttpRequestMessage(HttpMethod.Post, _options.Path)
            {
                Content = JsonContent.Create(body, JevWireJsonContext.Default.JevWireRequest),
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _options.ApiKey);

            using var response = await http.SendAsync(request, timeout.Token);
            if (!response.IsSuccessStatusCode)
            {
                var status = (int)response.StatusCode;
                logger.JevHttpFailure(status);
                return JevOutcome.Fail($"http-{status}", Elapsed(clock));
            }

            var parsed = await response.Content.ReadFromJsonAsync(JevWireJsonContext.Default.JevWireResponse, timeout.Token);
            return Map(prompt, parsed, Elapsed(clock));
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return JevOutcome.Fail("timeout", Elapsed(clock));
        }
        catch (JsonException)
        {
            return JevOutcome.Fail("malformed", Elapsed(clock));
        }
        catch (HttpRequestException ex)
        {
            logger.JevNetworkFailure(ex);
            return JevOutcome.Fail("network", Elapsed(clock));
        }
    }

    /// <summary>
    /// Accepts an answer only if it names an option the unit was actually offered and every
    /// probability is a finite value in [0, 1]. Anything else is schema drift, not a decision.
    /// </summary>
    internal static JevOutcome Map(JevPrompt prompt, JevWireResponse? response, int latencyMs)
    {
        var answers = response?.Answers;
        if (answers is null) return JevOutcome.Fail("malformed", latencyMs);

        if (!prompt.Questions.TryGetValue(JevPromptBuilder.ActionKey, out var actionQuestion)
            || !answers.TryGetValue(JevPromptBuilder.ActionKey, out var action))
        {
            return JevOutcome.Fail("malformed", latencyMs);
        }

        var actionCheck = CheckChoice(action, actionQuestion);
        if (actionCheck is not null) return JevOutcome.Fail(actionCheck, latencyMs);

        string? focus = null;
        double focusConfidence = 0;
        Dictionary<string, double>? focusProbabilities = null;
        if (prompt.Questions.TryGetValue(JevPromptBuilder.FocusKey, out var focusQuestion))
        {
            if (!answers.TryGetValue(JevPromptBuilder.FocusKey, out var focusAnswer)) return JevOutcome.Fail("malformed", latencyMs);
            var focusCheck = CheckChoice(focusAnswer, focusQuestion);
            if (focusCheck is not null) return JevOutcome.Fail(focusCheck, latencyMs);
            focus = focusAnswer.Choice;
            focusConfidence = focusAnswer.Confidence ?? 0;
            focusProbabilities = focusAnswer.Probabilities;
        }

        if (!answers.TryGetValue(JevPromptBuilder.PanicKey, out var panic) || panic.Noul is not { } noul)
        {
            return JevOutcome.Fail("malformed", latencyMs);
        }
        if (!IsProbability(noul)) return JevOutcome.Fail("bad-probability", latencyMs);

        var usage = response!.Usage is { } u ? new JevUsage(u.InputTokens, u.OutputTokens, u.Cost ?? 0) : new JevUsage(0, 0, 0);
        return new JevOutcome(
            Ok: true,
            Failure: null,
            Answers: new JevAnswers(
                action.Choice!, action.Confidence ?? 0, action.Probabilities ?? [],
                focus, focusConfidence, focusProbabilities, noul),
            Usage: usage,
            LatencyMs: latencyMs);
    }

    private static string? CheckChoice(JevWireAnswer answer, JevQuestion question)
    {
        if (answer.Choice is null) return "malformed";
        if (!question.Criteria.ContainsKey(answer.Choice)) return "unknown-option";
        if (answer.Confidence is { } c && !IsProbability(c)) return "bad-probability";
        if (answer.Probabilities is { } probabilities)
        {
            foreach (var (option, p) in probabilities)
            {
                if (!question.Criteria.ContainsKey(option)) return "unknown-option";
                if (!IsProbability(p)) return "bad-probability";
            }
        }
        return null;
    }

    private static bool IsProbability(double p) => double.IsFinite(p) && p is >= 0 and <= 1;

    private static int Elapsed(Stopwatch clock) => (int)Math.Min(int.MaxValue, clock.ElapsedMilliseconds);
}
