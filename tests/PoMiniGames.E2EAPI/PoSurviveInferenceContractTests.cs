using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.AI;
using PoMiniGames.AI;
using PoMiniGames.Features.Auth;
using PoMiniGames.TestUtilities;
using PoMiniGames.Shared.Simulation.Models;

namespace PoMiniGames.E2EAPI;

/// <summary>
/// HTTP contract for PoSurvive's cloud inference relay (<c>/api/infer</c>) — the path that
/// had zero test coverage of any kind while it was failing 100 % of calls in a live run
/// (2026-07-29: 15 requests, 0 completions, every agent on the fallback table while the
/// header still read "AI online").
/// </summary>
/// <remarks>
/// <para>
/// The model is replaced by a <see cref="StubChatClient"/> registered against the same keyed
/// <see cref="IChatClient"/> the production wiring uses, so these tests exercise the real
/// endpoint, the real <c>AzureOpenAIInferenceService</c>, and the real options/parse path
/// without spending a token — which is what lets the fixture flip
/// <c>Inference:UseCloudFallback</c> on despite <see cref="TestBudgetGuard"/> pinning it off
/// (the guard's intent is "never dial Azure OpenAI", and nothing here can).
/// </para>
/// <para>
/// Grouped into few methods on purpose: the E2E-API tier is capped at 25 test methods by the
/// 100/50/25/25 rule, and both hermetic tiers (Unit 100/100, Integration 50/50) are full.
/// </para>
/// </remarks>
public sealed class PoSurviveInferenceContractTests
{
    private const string ValidGridJson =
        """{"self":{"id":"R1","team":"Red","x":4,"y":5,"hp":72,"hunger":0.61},"agents":[],"food":[],"rocks":[]}""";

    private static PersonalityDnaDto Dna => new(0.9f, 0.2f, 0.1f, 0.1f, 0.3f);

    private static InferRequestDto Request => new(ValidGridJson, Dna, ModelId: null);

    // ── Stub model ────────────────────────────────────────────────────────────

    /// <summary>
    /// Stands in for the Azure OpenAI deployment. Records the <see cref="ChatOptions"/> the
    /// service sent so the tests can assert the request shape, not just the reply.
    /// </summary>
    private sealed class StubChatClient : IChatClient
    {
        private readonly Func<ChatOptions?, CancellationToken, Task<ChatResponse>> _respond;

        public StubChatClient(Func<ChatOptions?, CancellationToken, Task<ChatResponse>> respond)
            => _respond = respond;

        public ChatOptions? LastOptions { get; private set; }

        public Task<ChatResponse> GetResponseAsync(
            IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
        {
            LastOptions = options;
            return _respond(options, cancellationToken);
        }

        public IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
            => throw new NotSupportedException("PoSurvive does not stream.");

        public object? GetService(Type serviceType, object? serviceKey = null) => null;

        public void Dispose() { }
    }

    private static ChatResponse TextReply(string text, int totalTokens = 200) =>
        new(new ChatMessage(ChatRole.Assistant, text))
        {
            Usage = new UsageDetails
            {
                InputTokenCount = totalTokens / 2,
                OutputTokenCount = totalTokens / 2,
                TotalTokenCount = totalTokens,
            },
        };

    // ── Host ──────────────────────────────────────────────────────────────────

    private sealed class InferenceFactory : WebApplicationFactory<Program>
    {
        private readonly StubChatClient _model;
        private readonly Dictionary<string, string?> _extraConfig;

        public InferenceFactory(StubChatClient model, Dictionary<string, string?>? extraConfig = null)
        {
            _model = model;
            _extraConfig = extraConfig ?? [];
        }

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Test");
            builder.ConfigureAppConfiguration((_, cfg) =>
            {
                var overrides = new Dictionary<string, string?>(TestBudgetGuard.Overrides)
                {
                    ["Auth:EnableFakeAuth"] = "true",
                    // The relay is the subject under test; the stub model makes it inert.
                    ["Inference:UseCloudFallback"] = "true",
                    ["Inference:UseCentralizedFoundry"] = "true",
                    ["PoMiniGames:AI:FoundryEndpoint"] = "https://stub.invalid",
                    ["PoMiniGames:AI:DefaultDeployment"] = "stub-default",
                    ["PoMiniGames:AI:Deployments:survive"] = "stub-survive",
                    // Legacy key that must NOT win the status report any more.
                    ["Inference:DeploymentName"] = "legacy-never-served-this",
                };
                foreach (var (k, v) in _extraConfig)
                {
                    overrides[k] = v;
                }
                cfg.AddInMemoryCollection(overrides);
            });

            builder.ConfigureTestServices(services =>
            {
                services.AddAuthentication(options =>
                {
                    options.DefaultAuthenticateScheme = FakeAuthHandler.SchemeName;
                    options.DefaultChallengeScheme = FakeAuthHandler.SchemeName;
                    options.DefaultScheme = FakeAuthHandler.SchemeName;
                })
                .AddScheme<AuthenticationSchemeOptions, FakeAuthHandler>(FakeAuthHandler.SchemeName, _ => { });

                // Same key the production wiring registers, so the endpoint, the service and
                // the option-building path under test are all the real ones.
                services.AddKeyedSingleton<IChatClient>(AIFoundryOptions.Games.Survive, _model);
            });
        }

        protected override void ConfigureClient(HttpClient client)
        {
            client.DefaultRequestHeaders.Add(FakeAuthHandler.UserHeader, "infer-test-user");
            base.ConfigureClient(client);
        }
    }

    // ── Tests ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// The happy path, plus the request shape that makes it a happy path. The deployment
    /// serving this game is a reasoning-family model: with no options it spends its whole
    /// budget thinking and never answers (measured: 3 × 15 s SDK attempts → 503 at 51.6 s),
    /// and a token cap alone returns HTTP 200 with an empty completion. Bounded output plus
    /// minimal reasoning effort is the combination that answers in ~1 s, and a strict JSON
    /// schema is what makes the action unforgeable instead of scraped out of prose.
    /// </summary>
    [Fact]
    public async Task Relay_ParsesDecision_AndConstrainsReasoningTokensAndSchema()
    {
        var model = new StubChatClient((_, _) =>
            Task.FromResult(TextReply("""Sure! Here you go: {"action":"Flee","thought":"Outnumbered; fall back"}""")));
        await using var factory = new InferenceFactory(model);
        // §2 CSRF: /api/infer is a POST under /api/*, gated on the synchroniser token.
        using var client = await factory.CreateClient().ArmAntiforgeryAsync();

        var response = await client.PostAsJsonAsync("/api/infer", Request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var result = await response.Content.ReadFromJsonAsync<InferenceResult>();
        result!.Action.Should().Be("Flee");
        result.Thought.Should().Be("Outnumbered; fall back");

        var sent = model.LastOptions;
        sent.Should().NotBeNull(because: "sending no ChatOptions is what made every live call time out");
        sent!.MaxOutputTokens.Should().BeGreaterThan(0).And.BeLessThanOrEqualTo(1_000);

        sent.ResponseFormat.Should().BeOfType<ChatResponseFormatJson>(
            because: "a strict schema removes the prose-scraping parser's failure modes");
        var json = (ChatResponseFormatJson)sent.ResponseFormat!;
        json.SchemaName.Should().Be("agent_decision");
        // ValueKind, not just HasValue: a JsonElement is a struct, so a schema that was never
        // assigned travels as Undefined rather than null and no provider complains about it.
        json.Schema!.Value.ValueKind.Should().Be(JsonValueKind.Object);
        json.Schema.Value.GetRawText().Should()
            .Contain("Attack").And.Contain("Forage").And.Contain("Flee").And.Contain("Idle");

        // The reasoning cap has no first-class ME.AI property, so it rides on the raw
        // provider options — assert on what actually goes over the wire.
        var raw = sent.RawRepresentationFactory!(model);
        var wire = System.ClientModel.Primitives.ModelReaderWriter.Write(
            (System.ClientModel.Primitives.IJsonModel<OpenAI.Chat.ChatCompletionOptions>)raw!).ToString();
        wire.Should().Contain("reasoning_effort").And.Contain("minimal");
    }

    /// <summary>
    /// A model reply with no usable JSON must be reported as a gateway failure, not handed
    /// back as a decision. The relay used to answer 200 with <c>Action = "Idle"</c> and
    /// <c>Thought = "unparseable model response"</c>, which the client could not distinguish
    /// from a real choice to stand still.
    /// </summary>
    [Fact]
    public async Task Relay_Returns502_WhenModelEmitsNoUsableJson()
    {
        var model = new StubChatClient((_, _) => Task.FromResult(TextReply("")));
        await using var factory = new InferenceFactory(model);
        using var client = await factory.CreateClient().ArmAntiforgeryAsync();

        var response = await client.PostAsJsonAsync("/api/infer", Request);

        response.StatusCode.Should().Be(HttpStatusCode.BadGateway);
    }

    /// <summary>
    /// The server must give up before the caller does. The client abandons each agent at
    /// <c>Inference:InferenceTimeoutMs</c> (15 s), yet a measured relay call kept a
    /// connection and a token budget alive for 51.6 s producing work nobody would read.
    /// </summary>
    [Fact]
    public async Task Relay_Returns504_WhenTheModelOutlastsTheServerBudget()
    {
        var model = new StubChatClient(async (_, ct) =>
        {
            await Task.Delay(TimeSpan.FromSeconds(30), ct);
            return TextReply("""{"action":"Idle","thought":"too late"}""");
        });
        await using var factory = new InferenceFactory(model, new Dictionary<string, string?>
        {
            ["Inference:ServerBudgetMs"] = "700",
        });
        using var client = await factory.CreateClient().ArmAntiforgeryAsync();

        var started = DateTimeOffset.UtcNow;
        var response = await client.PostAsJsonAsync("/api/infer", Request);
        var elapsed = DateTimeOffset.UtcNow - started;

        response.StatusCode.Should().Be(HttpStatusCode.GatewayTimeout);
        elapsed.Should().BeLessThan(TimeSpan.FromSeconds(15),
            because: "the whole point is to fail before the caller's own budget expires");
    }

    /// <summary>
    /// Cost ceiling. The <c>infer</c> rate limit allows 10 req/s per partition with no token
    /// accounting at all — 36 000 calls/hour from one tab against a metered deployment. A
    /// per-identity token budget is the backstop; exceeding it is a 429, not a silent bill.
    /// </summary>
    [Fact]
    public async Task Relay_Returns429_WhenTheIdentityTokenBudgetIsSpent()
    {
        var model = new StubChatClient((_, _) =>
            Task.FromResult(TextReply("""{"action":"Attack","thought":"Engage"}""", totalTokens: 400)));
        await using var factory = new InferenceFactory(model, new Dictionary<string, string?>
        {
            ["PoMiniGames:AI:TokenBudget:DailyTokensPerIdentity"] = "300",
        });
        using var client = await factory.CreateClient().ArmAntiforgeryAsync();

        var first = await client.PostAsJsonAsync("/api/infer", Request);
        first.StatusCode.Should().Be(HttpStatusCode.OK, because: "the budget is only spent after a call lands");

        var second = await client.PostAsJsonAsync("/api/infer", Request);
        second.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        second.Headers.RetryAfter.Should().NotBeNull(because: "a budget refusal must say when to come back");
    }

    /// <summary>
    /// Status must describe the deployment that actually serves requests. It resolved the name
    /// by reading raw config keys while the chat client resolved through
    /// <see cref="AIFoundryOptions"/>: live, status advertised <c>gpt-4o-mini</c> (a deployment
    /// that does not exist on the account) while calls went to the Key Vault default.
    /// </summary>
    [Fact]
    public async Task Status_ReportsTheDeploymentTheChatClientIsBoundTo()
    {
        var model = new StubChatClient((_, _) =>
            Task.FromResult(TextReply("""{"action":"Idle","thought":"Hold"}""")));
        await using var factory = new InferenceFactory(model);
        using var client = factory.CreateClient();

        var status = await client.GetFromJsonAsync<InferenceStatusDto>("/api/infer/status");

        status!.Available.Should().BeTrue();
        status.ModelId.Should().Be("stub-survive",
            because: "PoMiniGames:AI:Deployments:survive is what AIFoundryOptions.ResolveDeployment returns");
        status.ModelId.Should().NotBe("legacy-never-served-this");
    }

    /// <summary>
    /// The provider-health signal behind the status pill. "AI online" stayed green through 15
    /// consecutive failed calls because nothing tracked outcomes after bootstrap.
    /// </summary>
    [Fact]
    public void HealthTracker_DegradesAfterConsecutiveFailures_AndRecoversOnSuccess()
    {
        var tracker = new InferenceHealthTracker(failureThreshold: 3);

        tracker.IsDegraded.Should().BeFalse();

        tracker.RecordFailure();
        tracker.RecordFailure();
        tracker.IsDegraded.Should().BeFalse(because: "one slow turn is not an outage");

        tracker.RecordFailure();
        tracker.IsDegraded.Should().BeTrue();
        tracker.ConsecutiveFailures.Should().Be(3);

        tracker.RecordSuccess();
        tracker.IsDegraded.Should().BeFalse();
        tracker.ConsecutiveFailures.Should().Be(0);
    }
}
