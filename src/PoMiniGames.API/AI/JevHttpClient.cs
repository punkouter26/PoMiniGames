// filepath: src/PoMiniGames.API/AI/JevHttpClient.cs
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

namespace PoMiniGames.AI;

/// <summary>
/// HTTP client for the Jev <c>/v1/decisions</c> endpoint. Only the OpenAI-compatible
/// provider is wired today (OpenRouter hosts <c>typesafe/jev-1.13</c> at
/// <c>https://openrouter.ai/api/v1/chat/completions</c> under the <c>response_format</c>
/// schema, but TypeSafe's own <c>/v1/decisions</c> is the surface this client targets —
/// it is what the doc specifies for typed primitives).
///
/// <para>
/// <b>Why not the chat pipeline?</b> <see cref="BudgetedChatClient"/>, <see cref="ResilientChatClient"/>
/// and <see cref="InstrumentedChatClient"/> decorate <c>OpenAI.Chat.ChatClient</c>. Jev
/// does not stream tokens — it returns a typed JSON object — so the resilience and
/// budget chain does not apply. Jev gets its own <see cref="HttpClient"/> with a 1.5 s
/// timeout (see <see cref="JevOptions.CallTimeoutMs"/>) and a per-identity decision cap
/// (<see cref="JevOptions.DailyDecisionsPerIdentity"/>) instead.
/// </para>
///
/// <para>
/// <b>Failure semantics.</b> Every public method returns
/// <see cref="JevDecision{T}.Bypass"/> on <i>any</i> error — connection refused,
/// non-2xx, missing field, shape mismatch. The caller must treat Jev as an
/// optional, always-bypassable gate.
/// </para>
/// </summary>
public sealed class JevHttpClient : IJevClient
{
    private readonly HttpClient _http;
    private readonly IOptionsMonitor<JevOptions> _options;
    private readonly ILogger<JevHttpClient> _logger;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public JevHttpClient(HttpClient http, IOptionsMonitor<JevOptions> options, ILogger<JevHttpClient> logger)
    {
        _http = http;
        _options = options;
        _logger = logger;

        var opts = options.CurrentValue;
        if (opts.CallTimeoutMs > 0)
        {
            http.Timeout = TimeSpan.FromMilliseconds(opts.CallTimeoutMs);
        }
    }

    public Task<JevDecision<double>> EvaluateNoulAsync(string instructions, object state, CancellationToken ct = default)
        => EvaluateSingleAsync<double>(
            questionType: "noul",
            instructions: instructions,
            extra: null,
            state: state,
            readValue: static ans => ans.Noul ?? 0d,
            ct: ct);

    public Task<JevDecision<string>> EvaluateChoiceAsync(string instructions, IReadOnlyDictionary<string, string> criteria, object state, CancellationToken ct = default)
    {
        if (criteria.Count == 0)
        {
            // Jev cannot invent options outside the declared choice set; an empty
            // criteria means the caller forgot to populate the rubric. Bypass cleanly.
            _logger.LogWarning("Jev choice call has empty criteria; bypassing.");
            return Task.FromResult(JevDecision<string>.Bypass());
        }
        return EvaluateSingleAsync<string>(
            questionType: "choice",
            instructions: instructions,
            extra: new Dictionary<string, object> { ["criteria"] = criteria },
            state: state,
            readValue: static ans => ans.Choice ?? string.Empty,
            ct: ct);
    }

    public Task<JevDecision<double>> EvaluateScoreAsync(string instructions, IReadOnlyDictionary<string, string> levels, object state, CancellationToken ct = default)
    {
        if (levels.Count == 0)
        {
            _logger.LogWarning("Jev score call has empty levels; bypassing.");
            return Task.FromResult(JevDecision<double>.Bypass());
        }
        return EvaluateSingleAsync<double>(
            questionType: "score",
            instructions: instructions,
            extra: new Dictionary<string, object> { ["levels"] = levels },
            state: state,
            readValue: static ans => ans.Score ?? 0d,
            ct: ct);
    }

    private async Task<JevDecision<T>> EvaluateSingleAsync<T>(
        string questionType,
        string instructions,
        IReadOnlyDictionary<string, object>? extra,
        object state,
        Func<JevAnswer<T>, T> readValue,
        CancellationToken ct)
    {
        var opts = _options.CurrentValue;
        if (!opts.IsConfigured)
        {
            return JevDecision<T>.Bypass();
        }

        // Build the single-question payload. The endpoint accepts multiple questions
        // per call but every consumer here asks exactly one; pinning to one keeps the
        // answer index simple and avoids the 255-option second-stage pipeline.
        var question = new Dictionary<string, object>
        {
            ["type"] = questionType,
            ["instructions"] = instructions,
        };
        if (extra is not null)
        {
            foreach (var (k, v) in extra) question[k] = v;
        }

        var payload = new Dictionary<string, object?>
        {
            ["model"] = opts.Model,
            ["state"] = state,
            ["questions"] = new Dictionary<string, object>
            {
                ["q"] = question,
            },
        };

        try
        {
            // OpenRouter hosts Jev under /api/alpha/decisions (not /v1/decisions as the Jev
            // doc claims). The relative path here assumes <see cref="JevOptions.Endpoint"/>
            // is the host root (e.g. https://openrouter.ai); keep them in lockstep.
            using var req = new HttpRequestMessage(HttpMethod.Post, "api/alpha/decisions")
            {
                Content = JsonContent.Create(payload, options: JsonOptions),
            };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", opts.ApiKey);

            using var resp = await _http.SendAsync(req, ct);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("Jev returned {Status} for {Type} question; bypassing.", (int)resp.StatusCode, questionType);
                return JevDecision<T>.Bypass();
            }

            var parsed = await resp.Content.ReadFromJsonAsync<JevResponse<T>>(JsonOptions, ct);
            if (parsed is null || !parsed.Answers.TryGetValue("q", out var ans) || ans is null)
            {
                _logger.LogWarning("Jev response missing 'q' answer; bypassing.");
                return JevDecision<T>.Bypass();
            }

            return new JevDecision<T>(readValue(ans), ans.Confidence, FailingThrough: false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            // Any other failure (network, deserialization, schema drift) → bypass.
            // Never let Jev take down the calling endpoint.
            _logger.LogWarning(ex, "Jev call failed; bypassing.");
            return JevDecision<T>.Bypass();
        }
    }
}
