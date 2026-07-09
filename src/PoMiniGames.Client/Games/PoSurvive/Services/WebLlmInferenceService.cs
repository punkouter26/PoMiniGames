namespace PoMiniGamesClient.Games.PoSurvive.Services;

using System.Text.Json;
using Microsoft.JSInterop;
using PoShared.Simulation.Interfaces;
using PoShared.Simulation.Models;

// GoF: Strategy — real WebLLM implementation; registered in DI only when InferenceMode != Mock
// SOLID: SRP — responsible solely for bridging Blazor to the JS inferenceWorker.js
public sealed class WebLlmInferenceService : IInferenceService, IAsyncDisposable
{
    private readonly IJSRuntime _js;
    private readonly int        _inferenceTimeoutMs;
    private readonly int        _maxRetryAttempts;
    private readonly int        _retryDelayMs;
    private readonly bool       _retryOnCancellation;
    private static readonly AsyncLocal<InferenceDiagnosticsContext?> CurrentDiagnosticsContext = new();

    // JS interop helper for the worker bridge (loaded lazily from wwwroot/js/webLlmBridge.js)
    private IJSObjectReference? _bridge;
    private bool                _disposed;

    public WebLlmInferenceService(
        IJSRuntime js,
        int inferenceTimeoutMs = 15_000,
        int maxRetryAttempts = 3,
        int retryDelayMs = 750,
        bool retryOnCancellation = false)
    {
        _js                  = js;
        _inferenceTimeoutMs  = inferenceTimeoutMs;
        _maxRetryAttempts    = Math.Max(1, maxRetryAttempts);
        _retryDelayMs        = Math.Max(0, retryDelayMs);
        _retryOnCancellation = retryOnCancellation;
    }

    // ── IInferenceService ────────────────────────────────────────────────────

    public IDisposable BeginDiagnosticsScope(int turnNumber, string agentId, string? team)
    {
        var previous = CurrentDiagnosticsContext.Value;
        CurrentDiagnosticsContext.Value = new InferenceDiagnosticsContext(turnNumber, agentId, team);
        return new DisposableAction(() => CurrentDiagnosticsContext.Value = previous);
    }

    public async Task<InferenceResult> InferAsync(
        string            gridJson,
        PersonalityDnaDto dna,
        CancellationToken ct = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        // Build the dna object that inferenceWorker.js expects
        var dnaObj = new
        {
            predatory     = dna.Predatory,
            scavenger     = dna.Scavenger,
            paranoid      = dna.Paranoid,
            altruistic    = dna.Altruistic,
            methodical    = dna.Methodical,
            dominantTrait = GetDominantTrait(dna),
        };

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        // Note: Do NOT add cts.CancelAfter here — the serial JS queue may hold this request for
        // longer than _inferenceTimeoutMs before dispatch. The worker's own timeoutMs handles
        // per-request execution time; the outer CancellationToken handles overall safety.

        var context = CurrentDiagnosticsContext.Value;
        var sourceContext = context is null
            ? null
            : new
            {
                turnNumber = context.TurnNumber,
                agentId = context.AgentId,
                team = context.Team,
            };

        for (var attempt = 1; attempt <= _maxRetryAttempts; attempt++)
        {
            try
            {
                // Call the JS bridge which routes the message to the Web Worker
                var resultJson = await _js.InvokeAsync<string>(
                    "inferenceWorkerBridge.infer",
                    cts.Token,
                    gridJson,
                    dnaObj,
                    _inferenceTimeoutMs,
                    sourceContext);

                using var doc = System.Text.Json.JsonDocument.Parse(resultJson);
                var root = doc.RootElement;
                var thought = root.TryGetProperty("thought", out var t) ? t.GetString()
                            : root.TryGetProperty("Thought", out var t2) ? t2.GetString()
                            : null;
                var action = root.TryGetProperty("action", out var a) ? a.GetString()
                           : root.TryGetProperty("Action", out var a2) ? a2.GetString()
                           : null;

                return new InferenceResult(
                    Thought: thought ?? "Observing.",
                    Action:  action  ?? "Idle");
            }
            catch (OperationCanceledException)
            {
                var fallback = BuildFallbackResult(dna, sourceContext, "timeout", attempt);

                if (ct.IsCancellationRequested || cts.IsCancellationRequested)
                {
                    return fallback;
                }

                if (!_retryOnCancellation || attempt >= _maxRetryAttempts)
                {
                    return fallback;
                }

                await Task.Delay(_retryDelayMs, CancellationToken.None);
                continue;
            }
            catch (JSException ex)
            {
                if (attempt < _maxRetryAttempts)
                {
                    await Task.Delay(_retryDelayMs, CancellationToken.None);
                    continue;
                }

                // Surface the JS error as an Idle action — never crash the heartbeat loop
                var shortMsg = ex.Message[..Math.Min(80, ex.Message.Length)];
                var fallback = BuildFallbackResult(dna, sourceContext, "js_error", attempt);
                return fallback with
                {
                    Thought = $"Inference error after retries: {shortMsg}. {fallback.Thought}"
                };
            }
        }

        return BuildFallbackResult(dna, sourceContext, "unavailable", _maxRetryAttempts);
    }

    // ── IAsyncDisposable ─────────────────────────────────────────────────────

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        if (_bridge is not null)
        {
            await _bridge.DisposeAsync();
            _bridge = null;
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private static string GetDominantTrait(PersonalityDnaDto dna)
    {
        var traits = new (float Weight, string Name)[]
        {
            (dna.Predatory,  "Predatory"),
            (dna.Scavenger,  "Scavenger"),
            (dna.Paranoid,   "Paranoid"),
            (dna.Altruistic, "Altruistic"),
            (dna.Methodical, "Methodical"),
        };
        return traits.MaxBy(t => t.Weight).Name;
    }

    private static InferenceResult BuildFallbackResult(
        PersonalityDnaDto dna,
        object? sourceContext,
        string reason,
        int attempt)
    {
        return new InferenceResult(
            Thought: $"Inference {reason.Replace('_', ' ')}. Standing by.",
            Action: "Idle");
    }

    private static string SelectFallbackAction(
        string dominantTrait,
        object? sourceContext,
        string reason,
        int attempt)
    {
        var sequence = dominantTrait switch
        {
            "Predatory" => new[] { "Attack", "Flee", "Forage" },
            "Scavenger" => new[] { "Forage", "Idle", "Flee" },
            "Paranoid" => new[] { "Flee", "Forage", "Idle" },
            "Altruistic" => new[] { "Idle", "Forage", "Flee" },
            "Methodical" => new[] { "Forage", "Idle", "Attack" },
            _ => new[] { "Idle", "Forage", "Flee" },
        };

        var hash = HashCode.Combine(dominantTrait, reason, attempt, sourceContext?.GetHashCode() ?? 0);
        var index = (hash & int.MaxValue) % sequence.Length;
        return sequence[index];
    }

    // ── Private DTO (deserialising worker response) ───────────────────────────

    private sealed record InferenceWorkerResult(string Thought, string Action);

    private sealed record InferenceDiagnosticsContext(int TurnNumber, string AgentId, string? Team);

    private sealed class DisposableAction(Action onDispose) : IDisposable
    {
        private Action? _onDispose = onDispose;

        public void Dispose()
        {
            Interlocked.Exchange(ref _onDispose, null)?.Invoke();
        }
    }
}
