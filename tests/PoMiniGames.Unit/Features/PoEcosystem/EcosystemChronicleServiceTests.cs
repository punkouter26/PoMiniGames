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
    [InlineData("compress_log")]
    [InlineData("batch_thought")]
    [InlineData("treaty")]
    [InlineData("decree")]
    [InlineData("lore_culture")]
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
            case "compress_log":
                {
                    string[] rawLog =
                    [
                        "Y10: Fern ate clover",
                        "Y10: Hazel drank lake water",
                        "Y11: Pip the rabbit was born to Fern",
                        "Y12: Timber the wolf hunted a deer",
                        "Y13: Amber Clan built a Granary",
                        "Y14: Amber Clan discovered Toolcraft tech",
                        "Y15: Skirmish erupted at River Crossing with Cobalt Clan",
                    ];
                    var compressed = EcosystemChronicleService.CompressLog(rawLog);
                    compressed.Should().NotContain("ate clover");
                    compressed.Should().NotContain("drank lake water");
                    compressed.Should().Contain("1 births");
                    compressed.Should().Contain("1 predation casualties");
                    compressed.Should().Contain("1 structures built");
                    compressed.Should().Contain("1 tech discoveries");
                    compressed.Should().Contain("1 skirmishes/conflicts");
                    break;
                }
            case "batch_thought":
                {
                    var items = new List<EcoThoughtPromptItem>
                    {
                        new(1, "Rabbit", "Hazel", 0.8f, 0.2f, 1.0f, "forage", "food 10m"),
                        new(2, "Wolf", "Shadow", 0.5f, 0.1f, 0.9f, "hunt", "prey 15m"),
                    };
                    var batchReq = new EcoThoughtBatchRequest(items);
                    var mockBatch = EcosystemChronicleService.MockBatchThought(batchReq);
                    mockBatch.Results.Should().HaveCount(2);
                    mockBatch.Mock.Should().BeTrue();
                    mockBatch.Results[0].Id.Should().Be(1);
                    mockBatch.Results[0].Thought.Should().Contain("Hazel");

                    var rawJson = "[{\"id\": 1, \"thought\": \"Clover smells sweet.\", \"trait\": \"curiosity\", \"delta\": 0.1}]";
                    var parsed = EcosystemChronicleService.ParseBatchThoughts(rawJson);
                    parsed.Should().NotBeNull();
                    parsed!.Results.Should().HaveCount(1);
                    parsed.Results[0].Trait.Should().Be("curiosity");
                    break;
                }
            case "treaty":
                {
                    var tribeA = new TribeStateDto(1, "Amber Clan", "#d48806", TechTier.Toolcraft, 20, 5, 100, 50, 80, 0, 0, 20, [0, 0, 0]);
                    var tribeB = new TribeStateDto(2, "Cobalt Clan", "#1890ff", TechTier.Primitive, 15, 3, 60, 30, 40, 50, 50, 18, [0, 0, 0]);
                    var treatyReq = new EcoTreatyRequest(42, 15, tribeA, tribeB, "border skirmish over river fishing grounds");
                    var mockTreaty = EcosystemChronicleService.MockTreaty(treatyReq);
                    mockTreaty.Should().NotBeNull();
                    mockTreaty.Mock.Should().BeTrue();
                    mockTreaty.Title.Should().Contain("Amber Clan").And.Contain("Cobalt Clan");
                    mockTreaty.PeaceYears.Should().BeGreaterThan(0);

                    var parsedTreaty = EcosystemChronicleService.ParseTreaty("{\"title\":\"Peace Accord\",\"narrative\":\"Tribes laid down arms.\",\"action\":\"PeaceTreaty\",\"demandedResource\":\"Stone\",\"resourceAmount\":25,\"peaceYears\":4}");
                    parsedTreaty.Should().NotBeNull();
                    parsedTreaty!.Action.Should().Be("PeaceTreaty");
                    parsedTreaty.DemandedResource.Should().Be("Stone");
                    parsedTreaty.ResourceAmount.Should().Be(25);
                    break;
                }
            case "decree":
                {
                    var decreeReq = new EcoDecreeRequest(123, 5, "Send a pack of wolves to test the village");
                    var mockDecree = EcosystemChronicleService.MockDecree(decreeReq);
                    mockDecree.Should().NotBeNull();
                    mockDecree.ActionType.Should().Be("SpawnCreatures");
                    mockDecree.TargetEntity.Should().Be("Wolf");
                    mockDecree.Quantity.Should().BeInRange(1, 10);

                    var rainReq = new EcoDecreeRequest(123, 5, "Bring rain and storm to the parched lands");
                    var rainDecree = EcosystemChronicleService.MockDecree(rainReq);
                    rainDecree.ActionType.Should().Be("NudgeWeather");

                    var parsedDecree = EcosystemChronicleService.ParseDecree("{\"intent\":\"Bounty\",\"actionType\":\"SpawnResource\",\"targetTribeId\":1,\"targetEntity\":\"Food\",\"quantity\":60,\"divineMessage\":\"May your granaries swell.\"}");
                    parsedDecree.Should().NotBeNull();
                    parsedDecree!.ActionType.Should().Be("SpawnResource");
                    parsedDecree.Quantity.Should().Be(60);
                    break;
                }
            case "lore_culture":
                {
                    var loreReq = new EcoMilestoneLoreRequest(77, 25, "FirstGranary", "Amber Clan", "Completed the first stone storehouse");
                    var mockLore = EcosystemChronicleService.MockLore(loreReq);
                    mockLore.Should().NotBeNull();
                    mockLore.Mock.Should().BeTrue();
                    mockLore.OralLegend.Should().Contain("Amber Clan");

                    var parsedLore = EcosystemChronicleService.ParseLore("{\"epithet\":\"The Stone Age Dawn\",\"oralLegend\":\"When the storehouses rose, winter held no fear.\"}");
                    parsedLore.Should().NotBeNull();
                    parsedLore!.Epithet.Should().Be("The Stone Age Dawn");
                    break;
                }
        }
    }
}
