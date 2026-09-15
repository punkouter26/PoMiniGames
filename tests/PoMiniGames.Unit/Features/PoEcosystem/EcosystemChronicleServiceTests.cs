using FluentAssertions;
using PoMiniGames.Features.PoEcosystem;
using PoMiniGames.Shared.Games.PoEcosystem;

namespace PoMiniGames.Unit.Features.PoEcosystem;

/// <summary>
/// The chronicler's pure edges: request hygiene, reply parsing, and the canned fallbacks.
/// One theory over the three because the Unit tier sits at its ceiling; each row is one
/// contract the endpoint and the mock-mode E2E path rely on.
/// </summary>
public sealed class EcosystemChronicleServiceTests
{
    private static EcoChronicleRequest Request(int lines = 3) => new(
        Seed: 7, FromYear: 10, ToYear: 20, Tribe: "Moss",
        Counts: [12, 8, 3, 6], Extinct: [false, false, false, false],
        Log: Enumerable.Range(0, lines).Select(i => $"Y1{i}: Fern the rabbit was killed by Ember").ToArray(),
        Almanac: "born 40/20/6/4");

    [Theory]
    [InlineData("sanitize")]
    [InlineData("parse")]
    [InlineData("mock")]
    [InlineData("contracts")]
    public void Chronicler_PureEdges_HoldTheirContracts(string edge)
    {
        switch (edge)
        {
            case "contracts":
                {
                    // Multi-tribe telemetry and building contracts serialize cleanly with the source-generated context
                    var tribe = new TribeStateDto(
                        Id: 0,
                        Name: "Amber Clan",
                        BannerColor: "#d48806",
                        Tech: TechTier.Primitive,
                        Population: 8,
                        Warriors: 2,
                        Wood: 50,
                        Stone: 20,
                        Food: 120,
                        CenterX: 10.5f,
                        CenterZ: 15.2f,
                        TerritoryRadius: 28.0f,
                        Relations: [0, 1, 2]);

                    var building = new BuildingStateDto(
                        Id: 1,
                        TribeId: 0,
                        Kind: BuildingKind.Hut,
                        X: 12.0f,
                        Z: 14.5f,
                        Progress: 1.0f,
                        Health: 100.0f,
                        IsComplete: true);

                    var telemetry = new EcosystemTelemetryDeltaDto(
                        Year: 3,
                        Day: 4,
                        Tick: 1200,
                        Tribes: [tribe],
                        Buildings: [building],
                        RabbitCount: 35,
                        WolfCount: 5,
                        TotalHumanCount: 8,
                        IsYearMilestone: false);

                    var json = System.Text.Json.JsonSerializer.Serialize(telemetry, PoEcosystemJsonContext.Default.EcosystemTelemetryDeltaDto);
                    json.Should().NotBeNullOrWhiteSpace();

                    var restored = System.Text.Json.JsonSerializer.Deserialize(json, PoEcosystemJsonContext.Default.EcosystemTelemetryDeltaDto);
                    restored.Should().NotBeNull();
                    restored!.Tribes.Should().HaveCount(1);
                    restored.Tribes[0].Name.Should().Be("Amber Clan");
                    restored.Tribes[0].Tech.Should().Be(TechTier.Primitive);
                    restored.Buildings.Should().HaveCount(1);
                    restored.Buildings[0].Kind.Should().Be(BuildingKind.Hut);
                    break;
                }
            case "sanitize":
                {
                    // Over-long logs and lines are clipped, counts are padded to four, the tribe is
                    // letters only, and the span never runs backwards — the model is paid per token.
                    var oversized = Request(lines: EcosystemChronicleService.MaxLogLines + 50) with
                    {
                        Tribe = "<b>Mo ss</b>",
                        Counts = [5],
                        Extinct = [true],
                        FromYear = 30,
                        ToYear = 20,
                        Log = [new string('x', EcosystemChronicleService.MaxLogLineChars + 100), "", "Y1: kept"],
                    };
                    var clean = EcosystemChronicleService.Sanitize(oversized);
                    clean.Log.Should().HaveCount(2, "blank lines are dropped");
                    clean.Log[0].Length.Should().Be(EcosystemChronicleService.MaxLogLineChars);
                    clean.Tribe.Should().Be("bMossb");
                    clean.Counts.Should().Equal(5, 0, 0, 0);
                    clean.Extinct.Should().Equal(true, false, false, false);
                    clean.ToYear.Should().BeGreaterThanOrEqualTo(clean.FromYear);
                    EcosystemChronicleService.Sanitize(Request(EcosystemChronicleService.MaxLogLines + 50)).Log
                        .Should().HaveCount(EcosystemChronicleService.MaxLogLines, "the newest lines win");
                    break;
                }
            case "parse":
                {
                    // A schema-shaped reply survives being wrapped in prose or a code fence; an
                    // empty saga is a failed generation, not a blank page.
                    var wrapped = "Here you go:\n```json\n{\"title\":\"The Moss Years\",\"saga\":\"Fern fell to Ember.\",\"epigraph\":\"So it goes.\"}\n```";
                    var parsed = EcosystemChronicleService.ParseChronicle(wrapped);
                    parsed.Should().NotBeNull();
                    parsed!.Title.Should().Be("The Moss Years");
                    parsed.Saga.Should().Be("Fern fell to Ember.");
                    parsed.Epigraph.Should().Be("So it goes.");
                    parsed.Mock.Should().BeFalse();
                    EcosystemChronicleService.ParseChronicle("{\"title\":\"x\",\"saga\":\"   \",\"epigraph\":\"\"}").Should().BeNull();
                    EcosystemChronicleService.ParseChronicle("not json at all").Should().BeNull();
                    break;
                }
            case "mock":
                {
                    // The canned saga is deterministic and built from the request, and the canned
                    // thought is JSON the browser's nudge parser (sim/thoughts/nudges.js) accepts.
                    var a = EcosystemChronicleService.MockChronicle(Request());
                    var b = EcosystemChronicleService.MockChronicle(Request());
                    a.Saga.Should().Be(b.Saga);
                    a.Mock.Should().BeTrue();
                    a.Title.Should().Contain("Moss").And.Contain("10").And.Contain("20");
                    a.Saga.Should().Contain("Fern the rabbit").And.Contain("12 rabbits");

                    var thought = EcosystemChronicleService.MockThought("Fern, adult female rabbit");
                    using var doc = System.Text.Json.JsonDocument.Parse(thought);
                    doc.RootElement.GetProperty("thought").GetString().Should().NotBeNullOrWhiteSpace();
                    new[] { "boldness", "sociability", "curiosity", "greed", "diligence" }.Should().Contain(doc.RootElement.GetProperty("trait").GetString());
                    doc.RootElement.GetProperty("delta").GetDouble().Should().BeInRange(-0.25, 0.25);
                    EcosystemChronicleService.MockThought("Fern, adult female rabbit").Should().Be(thought, "same prompt, same line");
                    break;
                }
        }
    }
}
