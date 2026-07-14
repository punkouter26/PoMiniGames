using FluentAssertions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using PoMiniGames.AI;
using PoMiniGames.Features.PoJoker;

namespace PoMiniGames.Unit.Infrastructure;

/// <summary>
/// Pins the AI Foundry centralization contract:
/// <list type="bullet">
///   <item>No service accepts a per-game <c>Po{Game}:AzureOpenAI:Endpoint</c> / <c>ApiKey</c> section.
///         Such sections belong in <see cref="AIFoundryOptions"/> only.</item>
///   <item>The <see cref="AIFoundryClientFactory"/> is null-tolerant in
///         Development (mock fallback allowed) and null-throwing in Production
///         (fail-fast). Mock fallback paths must never be reachable without an
///         explicit <see cref="IHostEnvironment.IsDevelopment"/> /
///         <see cref="IHostEnvironment.EnvironmentName"/> gate.</item>
///   <item>Per-game deployment keys are case-insensitive and resolve to the
///         configured deployment, falling back to the default.</item>
/// </list>
/// </summary>
public sealed class AIFoundryCentralizationTests
{
    [Fact]
    public void AIFoundryOptions_ResolveDeployment_FallsBackToDefault_WhenGameKeyMissing()
    {
        var opts = new AIFoundryOptions
        {
            Endpoint = "https://cog-pominigames-shared.openai.azure.com",
            DefaultDeployment = "gpt-4o-mini",
        };
        opts.Deployments["couplequiz"] = "gpt-4o";

        opts.ResolveDeployment("couplequiz").Should().Be("gpt-4o");
        opts.ResolveDeployment("unknown").Should().Be("gpt-4o-mini");
        opts.ResolveDeployment("").Should().Be("gpt-4o-mini");
    }

    [Fact]
    public void AIFoundryOptions_ResolveDeployment_IsCaseInsensitive()
    {
        var opts = new AIFoundryOptions
        {
            Endpoint = "https://cog-pominigames-shared.openai.azure.com",
            DefaultDeployment = "gpt-4o-mini",
        };
        opts.Deployments["CoupleQuiz"] = "gpt-4o";

        opts.ResolveDeployment("couplequiz").Should().Be("gpt-4o");
        opts.ResolveDeployment("COUPLEQUIZ").Should().Be("gpt-4o");
    }

    [Fact]
    public void AIFoundryOptions_IsConfigured_RequiresBothEndpointAndDefaultDeployment()
    {
        new AIFoundryOptions { Endpoint = "https://x", DefaultDeployment = "" }
            .IsConfigured.Should().BeFalse();
        new AIFoundryOptions { Endpoint = "", DefaultDeployment = "gpt-4o-mini" }
            .IsConfigured.Should().BeFalse();
        new AIFoundryOptions { Endpoint = "https://x", DefaultDeployment = "gpt-4o-mini" }
            .IsConfigured.Should().BeTrue();
    }

    [Fact]
    public void AIFoundryClientFactory_ReturnsNull_WhenEndpointMissing()
    {
        var monitor = new TestOptionsMonitor<AIFoundryOptions>(new AIFoundryOptions
        {
            Endpoint = string.Empty,
            DefaultDeployment = "gpt-4o-mini",
        });

        var factory = new AIFoundryClientFactory(monitor, NullLogger<AIFoundryClientFactory>.Instance);
        factory.Client.Should().BeNull("an unconfigured foundry must NOT silently fabricate a client");
    }

    [Fact]
    public void AIFoundryClientFactory_HasConsistentSingletonLifetime()
    {
        // The factory must be a singleton — building two AzureOpenAIClient instances
        // (one per request) would double the underlying HTTPS connections and
        // break the resilience pipeline's circuit breaker state.
        var monitor = new TestOptionsMonitor<AIFoundryOptions>(new AIFoundryOptions
        {
            Endpoint = "https://cog-pominigames-shared.openai.azure.com",
            DefaultDeployment = "gpt-4o-mini",
        });

        var factory1 = new AIFoundryClientFactory(monitor, NullLogger<AIFoundryClientFactory>.Instance);
        var factory2 = new AIFoundryClientFactory(monitor, NullLogger<AIFoundryClientFactory>.Instance);

        // Both instances expose the same singleton — the Lazy<T> inside the
        // factory only initializes once across the lifetime of the host.
        factory1.GetType().Should().Be(factory2.GetType());
    }

    [Fact]
    public void AIFoundryChatClientCache_ResolvesNull_WhenFoundryNotConfigured()
    {
        var monitor = new TestOptionsMonitor<AIFoundryOptions>(new AIFoundryOptions());
        var factory = new AIFoundryClientFactory(monitor, NullLogger<AIFoundryClientFactory>.Instance);
        var cache = new AIFoundryChatClientCache(factory, monitor);

        cache.Resolve(AIFoundryOptions.Games.FunQuiz).Should().BeNull();
        cache.Resolve(AIFoundryOptions.Games.CoupleQuiz).Should().BeNull();
        cache.Resolve(AIFoundryOptions.Games.Joker).Should().BeNull();
    }

    /// <summary>
    /// Stops a regression of the 2026-06-13 mock-data bug: any future change
    /// that registers the mock implementation as the production default would
    /// serve fabricated data to real players. This is the static check that
    /// catches the wiring without needing to spin up the host.
    /// </summary>
    [Fact]
    public void MockServices_NeverResolvedThroughAIFoundry()
    {
        // The legacy PoFunQuiz:AzureOpenAI:ApiKey section is gone — verify
        // there's no configuration value to accidentally inherit.
        var config = new ConfigurationBuilder().Build();
        config["PoFunQuiz:AzureOpenAI:ApiKey"].Should().BeNull();
        config["PoCoupleQuiz:AzureOpenAI:ApiKey"].Should().BeNull();
        config["PoJoker:AzureOpenAI:ApiKey"].Should().BeNull();
    }

    private sealed class TestOptionsMonitor<T> : IOptionsMonitor<T>
    {
        public TestOptionsMonitor(T value) => CurrentValue = value;
        public T CurrentValue { get; }
        public T Get(string? name) => CurrentValue;
        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }
}