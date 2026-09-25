using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using PoMiniGames.Features.PoJevArena;
using PoMiniGames.Features.PoJevArena.Jev;
using Xunit;

namespace PoMiniGames.Unit.Features.PoJevArena;

/// <summary>
/// Every way a Jev reply can go wrong must come back as a typed failure (the unit then holds its
/// last intent) — never an exception, and never an answer outside the options the unit was offered.
/// </summary>
public sealed class JevClientTests
{
    private const string OkBody = """
        {
          "answers": {
            "tactical_action": { "type": "choice", "choice": "fall_back", "confidence": 0.82,
                                 "probabilities": { "melee_charge": 0.06, "fall_back": 0.82, "peel_to_ally": 0.12 } },
            "target_focus":    { "type": "choice", "choice": "nearest_threat", "confidence": 0.7,
                                 "probabilities": { "nearest_threat": 0.7, "weakest_target": 0.3 } },
            "panic_trigger":   { "type": "noul", "noul": 0.14 }
          },
          "model": "typesafe/jev-1.13-20260917",
          "usage": { "input_tokens": 476, "output_tokens": 70, "cost": 0.000019992 }
        }
        """;

    private static JevPrompt Prompt(bool withFocus = true)
    {
        var questions = new Dictionary<string, JevQuestion>
        {
            [JevPromptBuilder.ActionKey] = new("choice", "pick", new Dictionary<string, string>
            {
                ["melee_charge"] = "a", ["peel_to_ally"] = "b", ["fall_back"] = "c",
            }),
            [JevPromptBuilder.PanicKey] = new("noul", "panic?", new Dictionary<string, string> { ["true"] = "y", ["false"] = "n" }),
        };
        if (withFocus)
        {
            questions[JevPromptBuilder.FocusKey] = new("choice", "focus", new Dictionary<string, string>
            {
                ["nearest_threat"] = "a", ["weakest_target"] = "b",
            });
        }
        return new JevPrompt("Subject: Blue-01", questions);
    }

    [Theory]
    [InlineData("ok", null)]
    [InlineData("ok-no-focus-question", null)]
    [InlineData("not-configured", "not-configured")]
    [InlineData("missing-action", "malformed")]
    [InlineData("unknown-option", "unknown-option")]
    [InlineData("nan-confidence", "bad-probability")]
    [InlineData("probability-out-of-range", "bad-probability")]
    [InlineData("panic-missing", "malformed")]
    [InlineData("malformed-json", "malformed")]
    [InlineData("http-401", "http-401")]
    [InlineData("http-402", "http-402")]
    [InlineData("http-429", "http-429")]
    [InlineData("http-503", "http-503")]
    [InlineData("timeout", "timeout")]
    public async Task JevResponse_MapsOrFails(string scenario, string? expectedFailure)
    {
        HttpRequestMessage? sent = null;
        string? sentBody = null;
        var handler = new StubHandler(async (request, ct) =>
        {
            sent = request;
            sentBody = await request.Content!.ReadAsStringAsync(ct);
            return scenario switch
            {
                "http-401" => new HttpResponseMessage(HttpStatusCode.Unauthorized),
                "http-402" => new HttpResponseMessage(HttpStatusCode.PaymentRequired),
                "http-429" => new HttpResponseMessage(HttpStatusCode.TooManyRequests),
                "http-503" => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable),
                "timeout" => await Delay(ct),
                "malformed-json" => Json("{ not json"),
                _ => Json(Mutate(scenario)),
            };
        });

        var options = new JevOptions
        {
            ApiKey = scenario == "not-configured" ? "" : "sk-test",
            CallTimeoutMs = scenario == "timeout" ? 50 : 1500,
        };
        var client = new JevClient(
            new HttpClient(handler) { BaseAddress = new Uri(options.Endpoint) },
            Options.Create(options),
            new JevConcurrencyGate(Options.Create(options)),
            NullLogger<JevClient>.Instance);

        var outcome = await client.EvaluateAsync(Prompt(withFocus: scenario != "ok-no-focus-question"), "match-1", "user-hash");

        if (expectedFailure is not null)
        {
            outcome.Ok.Should().BeFalse();
            outcome.Failure.Should().Be(expectedFailure);
            outcome.Answers.Should().BeNull();
            return;
        }

        outcome.Ok.Should().BeTrue($"{scenario} should map, but failed with {outcome.Failure}");
        outcome.Answers!.Action.Should().Be("fall_back");
        outcome.Answers.ActionConfidence.Should().Be(0.82);
        outcome.Answers.ActionProbabilities.Should().ContainKey("peel_to_ally").WhoseValue.Should().Be(0.12);
        outcome.Answers.Panic.Should().Be(0.14);
        outcome.Usage!.InputTokens.Should().Be(476);
        outcome.Usage.CostUsd.Should().BeApproximately(0.000019992, 1e-12);

        if (scenario == "ok")
        {
            outcome.Answers.Focus.Should().Be("nearest_threat");
            outcome.Answers.FocusConfidence.Should().Be(0.7);
        }
        else
        {
            // The reply may still carry a target_focus answer, but it was never asked: ignore it.
            outcome.Answers.Focus.Should().BeNull();
        }

        // What we sent: bearer auth, the System One path, and the pinned model + observability ids.
        sent!.RequestUri!.ToString().Should().Be("https://openrouter.ai/api/v1/systemone");
        sent.Headers.Authorization!.ToString().Should().Be("Bearer sk-test");
        var body = JsonNode.Parse(sentBody!)!;
        body["model"]!.GetValue<string>().Should().Be("typesafe/jev-1.13");
        body["session_id"]!.GetValue<string>().Should().Be("match-1");
        body["user"]!.GetValue<string>().Should().Be("user-hash");
        body["questions"]!["tactical_action"]!["criteria"]!["fall_back"]!.GetValue<string>().Should().Be("c");
    }

    private static string Mutate(string scenario)
    {
        var node = JsonNode.Parse(OkBody)!;
        var answers = node["answers"]!;
        switch (scenario)
        {
            case "missing-action": answers.AsObject().Remove("tactical_action"); break;
            case "unknown-option": answers["tactical_action"]!["choice"] = "orbital_strike"; break;
            case "nan-confidence": answers["tactical_action"]!["confidence"] = "NaN"; break;
            case "probability-out-of-range": answers["target_focus"]!["probabilities"]!["weakest_target"] = 1.4; break;
            case "panic-missing": answers["panic_trigger"]!.AsObject().Remove("noul"); break;
        }
        return node.ToJsonString();
    }

    private static HttpResponseMessage Json(string body) =>
        new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private static async Task<HttpResponseMessage> Delay(CancellationToken ct)
    {
        await Task.Delay(TimeSpan.FromSeconds(5), ct);
        return Json(OkBody);
    }

    private sealed class StubHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> respond)
        : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            => respond(request, ct);
    }
}
