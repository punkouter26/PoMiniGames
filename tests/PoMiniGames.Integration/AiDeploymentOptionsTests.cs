using FluentAssertions;
using Microsoft.Extensions.AI;
using PoMiniGames.AI;
using PoMiniGames.Features.PoSurvive.Storage;

namespace PoMiniGames.Integration;

/// <summary>
/// Pins the two-step path every AI call now takes: resolve which deployment serves a key, then
/// build call options that deployment will actually accept.
/// </summary>
/// <remarks>
/// <para>
/// These two steps used to be independent and are now coupled on purpose, because the coupling is
/// what makes per-task model selection safe. Getting either half wrong fails in a way that is
/// invisible until a live call:
/// </para>
/// <list type="bullet">
///   <item>A task key that does not fall back to its game silently serves the global default —
///   the exact class of bug <c>ResolveDeployment</c> already carries a comment about, where the
///   status endpoint and the chat client disagreed about which model was answering.</item>
///   <item>Sending <c>reasoning_effort</c> or <c>response_format: json_schema</c> to a deployment
///   that does not implement them is a <c>400</c>, not a no-op. Measured against this account,
///   <c>Phi-4-mini-instruct</c> takes neither.</item>
/// </list>
/// <para>
/// Hermetic logic that would naturally sit in the Unit tier, but that tier is at its 100-method
/// ceiling, so it lives here per the 100/50/25/25 rule — and as a single <c>[Theory]</c>, because
/// this tier's own cap is 50 and a theory counts once however many rows it carries.
/// </para>
/// </remarks>
public class AiDeploymentOptionsTests
{
    /// <param name="requestedKey">Game or <c>game.task</c> key the call site asks for.</param>
    /// <param name="expectedDeployment">Deployment that key must resolve to.</param>
    /// <param name="expectSchema">Whether <c>json_schema</c> may be sent to it.</param>
    /// <param name="expectReasoning">Whether <c>reasoning_effort</c> may be sent to it.</param>
    [Theory]
    // A task key with its own entry wins.
    [InlineData("joker.rating", "gpt-5-nano", true, true)]
    // A task key with no entry falls back to its GAME, not to the global default.
    [InlineData("joker.explain", "gpt-5.4-nano", true, true)]
    // A plain game key resolves its own entry.
    [InlineData("funquiz", "gpt-5.4-mini", true, true)]
    // An unknown key falls through to the default.
    [InlineData("nosuchgame", "gpt-5.4-nano", true, true)]
    // A Phi deployment takes neither wire field, so the options must degrade to json_object mode.
    [InlineData("couplequiz.similarity", "Phi-4-mini-instruct", false, false)]
    public void ResolveDeployment_ThenBuildsOptionsTheDeploymentAccepts(
        string requestedKey, string expectedDeployment, bool expectSchema, bool expectReasoning)
    {
        var options = new AIFoundryOptions
        {
            Endpoint = "https://example.openai.azure.com",
            DefaultDeployment = "gpt-5.4-nano",
            Deployments = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["joker"] = "gpt-5.4-nano",
                ["joker.rating"] = "gpt-5-nano",
                ["funquiz"] = "gpt-5.4-mini",
                ["couplequiz.similarity"] = "Phi-4-mini-instruct",
            },
        };

        var deployment = options.ResolveDeployment(requestedKey);
        deployment.Should().Be(expectedDeployment);

        var chatOptions = AiDecisionChatOptions.ForStructuredJson(
            AiInferenceRelayService.AgentDecisionSchema,
            schemaName: "probe",
            maxOutputTokens: 128,
            deployment: deployment,
            capabilityOverrides: options.ModelCapabilityOverrides);

        // Both modes are JSON; the presence of the schema is what distinguishes them. Without it
        // the format is bare json_object and the contract travels in the prompt instead.
        chatOptions.ResponseFormat.Should().BeOfType<ChatResponseFormatJson>();
        ((ChatResponseFormatJson)chatOptions.ResponseFormat!).Schema.HasValue
            .Should().Be(expectSchema);

        // reasoning_effort rides on the raw representation; absent means it is never sent.
        (chatOptions.RawRepresentationFactory is not null).Should().Be(expectReasoning);
    }
}
