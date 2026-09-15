using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Caching.Hybrid;
using Microsoft.Extensions.Options;
using PoMiniGames.AI;
using PoMiniGames.Features.Shared;
using PoMiniGames.Shared.Games.PoEcosystem;

namespace PoMiniGames.Features.PoEcosystem;

/// <summary>The island's two model-backed jobs: a decade's saga, and one creature's thought.</summary>
public interface IEcosystemChronicleService
{
    Task<EcoChronicle> WriteAsync(EcoChronicleRequest request, CancellationToken ct = default);
    Task<EcoThoughtReply> ThinkAsync(EcoThoughtRequest request, CancellationToken ct = default);
}

/// <summary>
/// Server-side narrator for PoEcosystem. The chronicle turns the world log for a span of
/// years into a short saga; the thought endpoint answers the same prompt the in-browser
/// model would, for browsers without WebGPU.
/// </summary>
/// <remarks>
/// <para>
/// Both paths go through <see cref="GameChatClientFactory"/> under the <c>ecosystem</c> game
/// key, so they get the resilience partition, the durable per-identity token ceiling and
/// the telemetry by construction. Thoughts use the <c>ecosystem.thought</c> task key: it is
/// a one-sentence job and the cheap deployment is the right size for it.
/// </para>
/// <para>
/// The chronicle is cached 24 h on the content of the request (seed, span, log): the same
/// decade asked twice is the same saga, and a player reopening the dashboard is not a
/// second model call. Thoughts are not cached — every prompt is a different creature at a
/// different moment — which is why the browser throttles them hard and caps them per session.
/// </para>
/// <para>
/// Mock fallback follows <see cref="AiMockFallback"/>: canned output in Development and Test
/// when <c>PoEcosystem:Features:UseMockAI</c> is set or the foundry is unconfigured, an
/// <see cref="InvalidOperationException"/> (a 503 at the endpoint) in Production.
/// </para>
/// </remarks>
public sealed class EcosystemChronicleService : IEcosystemChronicleService
{
    public const int MaxLogLines = 120;
    public const int MaxLogLineChars = 240;
    private const int SagaMaxChars = 1400;
    private const int TitleMaxChars = 80;
    private const int EpigraphMaxChars = 160;
    private const int ThoughtMaxChars = 200;

    // The same contract the in-browser model is given (sim/thoughts/prompt.js SYSTEM_PROMPT),
    // stated here rather than taken from the request: the caller's text is data, not rules.
    private const string ThoughtSystemPrompt =
        "You voice the inner thoughts of one animal on a small island. Reply with ONLY this JSON, nothing else: " +
        "{\"thought\": \"<one short first-person sentence>\", \"trait\": \"<one of boldness|sociability|curiosity|greed|diligence>\", \"delta\": <number from -0.25 to 0.25>}. " +
        "The delta nudges that trait for a minute. " + AiPrompt.FencingInstruction;

    private const string ChronicleSystemPrompt =
        "You are the chronicler of a small island where rabbits, deer, wolves and a tribe of humans live, breed, hunt and die " +
        "without anyone steering them. Given a span of years and the island's log, write a short saga in plain, vivid prose: " +
        "name the creatures the log names, keep to what the log says happened, and make the decade feel like history rather than a list. " +
        "Emit only the JSON object described by the schema: {\"title\": \"<a title, at most ten words>\", " +
        "\"saga\": \"<two or three short paragraphs, under 1200 characters>\", \"epigraph\": \"<one closing line>\"}. " +
        AiPrompt.FencingInstruction;

    private readonly IConfiguration _configuration;
    private readonly IHostEnvironment _environment;
    private readonly ILogger<EcosystemChronicleService> _logger;
    private readonly GameChatClientFactory _clients;
    private readonly IOptionsMonitor<AIFoundryOptions> _foundry;
    private readonly IAiDecisionOptionsCache _options;
    private readonly HybridCache _cache;

    public EcosystemChronicleService(
        IConfiguration configuration,
        IHostEnvironment environment,
        ILogger<EcosystemChronicleService> logger,
        GameChatClientFactory clients,
        IOptionsMonitor<AIFoundryOptions> foundry,
        IAiDecisionOptionsCache options,
        HybridCache cache)
    {
        _configuration = configuration;
        _environment = environment;
        _logger = logger;
        _clients = clients;
        _foundry = foundry;
        _options = options;
        _cache = cache;
    }

    private bool UseMock => AiMockFallback.ShouldUseMock(_environment, _configuration.GetValue<bool>("PoEcosystem:Features:UseMockAI"));

    /// <summary>The decorated client for a key, or null when the foundry is unconfigured and mocks are allowed.</summary>
    private IChatClient? Client(string key, out string deployment)
    {
        deployment = _clients.DeploymentFor(key);
        if (UseMock) { _logger.EcoMockEnabled(_environment.EnvironmentName); return null; }
        var client = _foundry.CurrentValue.IsConfigured ? _clients.ForDeployment(key, deployment) : null;
        if (client is not null) return client;
        if (AiMockFallback.IsNonProduction(_environment)) { _logger.EcoNotConfigured(_environment.EnvironmentName); return null; }
        throw new InvalidOperationException($"PoEcosystem: AIFoundry not configured. Set {AIFoundryOptions.SectionName} in Key Vault (kv-poshared).");
    }

    public async Task<EcoChronicle> WriteAsync(EcoChronicleRequest request, CancellationToken ct = default)
    {
        var clean = Sanitize(request);
        var client = Client(AIFoundryOptions.Games.Ecosystem, out var deployment);
        if (client is null) return MockChronicle(clean);

        var key = "ecosystem:chronicle:" + Fingerprint(clean);
        var identity = AiUsageScope.CurrentIdentity;
        return await _cache.GetOrCreateAsync(
            key,
            (Service: this, Request: clean, Deployment: deployment, Identity: identity),
            static async (state, token) =>
            {
                using var scope = AiUsageScope.Restore(state.Identity);
                return await state.Service.WriteUncachedAsync(state.Request, state.Deployment, token);
            },
            new HybridCacheEntryOptions { Expiration = TimeSpan.FromHours(24), LocalCacheExpiration = TimeSpan.FromHours(1) },
            cancellationToken: ct);
    }

    private async Task<EcoChronicle> WriteUncachedAsync(EcoChronicleRequest request, string deployment, CancellationToken ct)
    {
        var client = Client(AIFoundryOptions.Games.Ecosystem, out _);
        if (client is null) return MockChronicle(request);
        try
        {
            var user = new StringBuilder()
                .Append("Years ").Append(request.FromYear).Append(" to ").Append(request.ToYear)
                .Append(" of the island. The human tribe is the ").Append(request.Tribe).Append(" tribe. ")
                .Append("Alive now: ").Append(CountsText(request.Counts)).Append(". ")
                .Append(ExtinctText(request.Extinct))
                .Append(string.IsNullOrWhiteSpace(request.Almanac) ? "" : "Almanac: " + request.Almanac + ". ")
                .Append('\n')
                // The log names creatures, and a player can name a creature anything — so it is data.
                .Append(AiPrompt.Fence(string.Join('\n', request.Log), "Log", 20_000))
                .ToString();

            var messages = new List<ChatMessage> { new(ChatRole.System, ChronicleSystemPrompt), new(ChatRole.User, user) };
            var options = _options.GetOrBuild(
                AIFoundryOptions.Games.Ecosystem, deployment, _clients.CapabilityOverrides,
                ChronicleSchema, "island_chronicle", 700, "A short saga of a span of years on the island.",
                (d, ov) => AiDecisionChatOptions.ForStructuredJson(ChronicleSchema, "island_chronicle", 700, d ?? string.Empty, "A short saga of a span of years on the island.", ov));

            var response = await client.GetResponseAsync(messages, options, ct);
            return ParseChronicle(response.Text) ?? MockChronicle(request);
        }
        catch (Exception ex)
        {
            _logger.EcoChronicleFailed(ex, request.Seed, request.FromYear, request.ToYear);
            if (AiMockFallback.IsNonProduction(_environment)) return MockChronicle(request);
            throw;
        }
    }

    public async Task<EcoThoughtReply> ThinkAsync(EcoThoughtRequest request, CancellationToken ct = default)
    {
        var prompt = (request.Prompt ?? string.Empty).Trim();
        var client = Client(AIFoundryOptions.Tasks.EcosystemThought, out var deployment);
        if (client is null) return new EcoThoughtReply(MockThought(prompt), Mock: true);
        try
        {
            var messages = new List<ChatMessage>
            {
                new(ChatRole.System, ThoughtSystemPrompt),
                new(ChatRole.User, AiPrompt.Fence(prompt, "Creature", 800)),
            };
            var options = _options.GetOrBuildText(
                AIFoundryOptions.Tasks.EcosystemThought, deployment, _clients.CapabilityOverrides, 90,
                (d, ov) => AiDecisionChatOptions.ForBoundedText(90, d ?? string.Empty, ov));
            var response = await client.GetResponseAsync(messages, options, ct);
            var text = (response.Text ?? string.Empty).Trim();
            if (text.Length > ThoughtMaxChars) text = text[..ThoughtMaxChars];
            return new EcoThoughtReply(text, Mock: false);
        }
        catch (Exception ex)
        {
            _logger.EcoThoughtFailed(ex);
            if (AiMockFallback.IsNonProduction(_environment)) return new EcoThoughtReply(MockThought(prompt), Mock: true);
            throw;
        }
    }

    // ── request hygiene ──────────────────────────────────────────────────
    /// <summary>Bound everything the client supplied: the model is charged per token and the log is free text.</summary>
    internal static EcoChronicleRequest Sanitize(EcoChronicleRequest r)
    {
        var log = (r.Log ?? [])
            .Where(l => !string.IsNullOrWhiteSpace(l))
            .Select(l => l.Length > MaxLogLineChars ? l[..MaxLogLineChars] : l)
            .TakeLast(MaxLogLines)
            .ToArray();
        var tribe = new string((r.Tribe ?? "island").Where(char.IsLetterOrDigit).Take(24).ToArray());
        if (tribe.Length == 0) tribe = "island";
        var counts = (r.Counts ?? []).Take(4).Select(c => Math.Max(0, c)).ToArray();
        if (counts.Length < 4) counts = [.. counts, .. new int[4 - counts.Length]];
        var extinct = (r.Extinct ?? []).Take(4).ToArray();
        if (extinct.Length < 4) extinct = [.. extinct, .. new bool[4 - extinct.Length]];
        var from = Math.Max(0, r.FromYear);
        var to = Math.Max(from, r.ToYear);
        var almanac = r.Almanac is null ? null : (r.Almanac.Length > 400 ? r.Almanac[..400] : r.Almanac);
        return new EcoChronicleRequest(r.Seed, from, to, tribe, counts, extinct, log, almanac);
    }

    private static string Fingerprint(EcoChronicleRequest r)
    {
        var text = $"{r.Seed}|{r.FromYear}|{r.ToYear}|{r.Tribe}|{string.Join(',', r.Counts)}|{string.Join('\n', r.Log)}";
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..32];
    }

    private static readonly string[] SpeciesPlural = ["rabbits", "deer", "wolves", "humans"];

    private static string CountsText(int[] counts)
        => string.Join(", ", counts.Select((c, i) => $"{c} {SpeciesPlural[i]}"));

    private static string ExtinctText(bool[] extinct)
    {
        var gone = extinct.Select((e, i) => e ? SpeciesPlural[i] : null).Where(s => s is not null).ToArray();
        return gone.Length == 0 ? "" : $"Extinct: {string.Join(", ", gone)}. ";
    }

    // ── output ───────────────────────────────────────────────────────────
    public static JsonElement ChronicleSchema { get; } = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "title": { "type": "string" },
            "saga": { "type": "string" },
            "epigraph": { "type": "string" }
          },
          "required": ["title", "saga", "epigraph"],
          "additionalProperties": false
        }
        """).RootElement.Clone();

    /// <summary>Parse a schema-shaped reply, tolerating fenced or prefixed text around the object.</summary>
    internal static EcoChronicle? ParseChronicle(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        if (start < 0 || end <= start) return null;
        try
        {
            using var doc = JsonDocument.Parse(text[start..(end + 1)]);
            var root = doc.RootElement;
            var title = Clip(root.TryGetProperty("title", out var t) ? t.GetString() : null, TitleMaxChars);
            var saga = Clip(root.TryGetProperty("saga", out var s) ? s.GetString() : null, SagaMaxChars);
            var epigraph = Clip(root.TryGetProperty("epigraph", out var e) ? e.GetString() : null, EpigraphMaxChars);
            if (string.IsNullOrWhiteSpace(saga)) return null;
            return new EcoChronicle(string.IsNullOrWhiteSpace(title) ? "The island" : title, saga, epigraph, Mock: false, DateTimeOffset.UtcNow);
        }
        catch (JsonException) { return null; }
    }

    private static string Clip(string? s, int max)
    {
        var v = (s ?? string.Empty).Trim();
        return v.Length > max ? v[..max] : v;
    }

    /// <summary>
    /// A canned saga built from the request itself, so a mocked host still shows something
    /// that reflects the island rather than lorem ipsum. Deterministic: same request, same text.
    /// </summary>
    internal static EcoChronicle MockChronicle(EcoChronicleRequest r)
    {
        var lines = r.Log.TakeLast(5).Select(l => l.Contains(':') ? l[(l.IndexOf(':') + 1)..].Trim() : l).ToArray();
        var events = lines.Length == 0 ? "the seasons turned and nothing was written down" : string.Join("; ", lines);
        var saga = $"In the years {r.FromYear} to {r.ToYear} the {r.Tribe} tribe kept to its village while the island went about its business. " +
                   $"The log remembers this much: {events}. " +
                   $"When the decade closed there were {CountsText(r.Counts)} on the island.{(ExtinctText(r.Extinct).Length > 0 ? " " + ExtinctText(r.Extinct).Trim() : "")}";
        if (saga.Length > SagaMaxChars) saga = saga[..SagaMaxChars];
        return new EcoChronicle($"The {r.Tribe} years, {r.FromYear}–{r.ToYear}", saga, "Written by no one in particular.", Mock: true, DateTimeOffset.UtcNow);
    }

    private static readonly string[] MockTraits = ["boldness", "sociability", "curiosity", "greed", "diligence"];
    private static readonly string[] MockLines =
    [
        "The wind carries something I cannot name.", "I will keep to the others today.", "What lies past the far shore?",
        "Mine, before anyone else gets there.", "There is work in this before dark.",
    ];

    /// <summary>A parseable thought (sim/thoughts/nudges.js accepts it) chosen by the prompt's hash.</summary>
    internal static string MockThought(string prompt)
    {
        var h = 0;
        foreach (var c in prompt) h = unchecked(h * 31 + c);
        var k = Math.Abs(h) % MockTraits.Length;
        return $"{{\"thought\": \"{MockLines[k]}\", \"trait\": \"{MockTraits[k]}\", \"delta\": 0.05}}";
    }
}
