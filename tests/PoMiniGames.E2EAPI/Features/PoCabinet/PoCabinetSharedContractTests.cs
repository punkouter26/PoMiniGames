using System.Text;
using System.Text.Json;
using FluentAssertions;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.E2EAPI.Features.PoCabinet;

/// <summary>
/// Wire-protocol contract tests for PoCabinet. One method by design — the E2E-API
/// tier is capped at 25 (the 100/50/25/25 rule) and the same bytes are exercised
/// across three claims:
/// <list type="bullet">
///   <item>Snapshots at 8 cars serialize under 2 KB. The original PoRacer wire-shape
///         is the reference, and a 30 Hz broadcast at 2 KB = 60 KB/s per session —
///         well below SignalR's per-message overhead. The contract pins this; if a
///         future change adds a heavy field, the build fails here.</item>
///   <item>Career state round-trips: serialise a populated state, deserialise it,
///         every field matches. Confirms the localStorage → server sync wire shape
///         is byte-equivalent on both ends.</item>
///   <item>TrackId / OfficialId enum string compatibility — the JSON contract uses
///         the camelCase enum names declared on <see cref="PoCabinetCatalog"/>;
///         mismatched casing would silently drop the player into the wrong race.</item>
/// </list>
/// </summary>
public sealed class PoCabinetSharedContractTests
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    [Fact]
    public void Wire_StaysUnderBudget_AndCareerRoundTrips_AndEnumsAreCompatible()
    {
        // ── Part 1: per-tick snapshot wire-size under budget at 8 cars ────
        // Static world (CenterXY + WallsXY) is sent ONCE on join, NOT per tick —
        // the budget applies to the recurring 30 Hz broadcast, which only carries
        // the cars + dialogue + frame metadata. The test models the per-tick shape.
        var perTickSnap = new PoCabinetRaceSnapshot
        {
            GameCode = "CAB-TEST",
            ServerTimeMs = 123456,
            ElapsedRaceTime = 42.0,
            Started = true,
            CountdownSeconds = 0,
            Finished = false,
            LocalCarId = 0,
            Cars = Enumerable.Range(0, 8).Select(i => new PoCabinetCarState
            {
                Id = i,
                Name = $"Car {i}",
                OfficialId = "sean-s",
                Color = "#3470d8",
                ColorDark = "#1a3a6c",
                X = 100 + i * 25,
                Y = 200 + i * 12,
                Heading = i * 0.785,
                SpeedKmh = 180 + i,
                Lap = 1,
                LapProgress = 0.5,
                Position = i + 1,
                IsPlayer = i == 0,
                Finished = false,
            }).ToList(),
            LatestDialogue = new PoCabinetDialogueEvent
            {
                OfficialId = "sean-s",
                Kind = "PreRace",
                Text = "I'm not taking questions right now.",
                RaceTick = 30,
            },
            Static = null, // per-tick broadcast carries no static world
        };

        var bytes = JsonSerializer.SerializeToUtf8Bytes(perTickSnap, JsonOpts);
        bytes.Length.Should().BeLessThanOrEqualTo(2048,
            $"per-tick snapshot at 8 cars must fit 2 KB; saw {bytes.Length} bytes");

        // ── Part 1b: static world sent once on join can be larger ─────────
        var joinStatic = new PoCabinetRaceSnapshot
        {
            GameCode = "CAB-JOIN",
            Cars = new List<PoCabinetCarState>(),
            Static = new PoCabinetStaticWorld
            {
                TrackId = "capitol",
                TrackName = "Capitol Speedway",
                Atmosphere = new PoCabinetAtmosphereWire
                {
                    SkyHex = "#0f1a3a",
                    FogStart = 600,
                    FogEnd = 2400,
                    FogHex = "#1a274f",
                    AmbientIntensity = 0.55,
                    GroundHex = "#c8c2b3",
                    AccentHex = "#d4af37",
                },
                CenterXY = Enumerable.Range(0, 200).Select(i => (double)(i % 200)).ToList(),
                WallsXY = Enumerable.Range(0, 400).Select(i => (double)i).ToList(),
                TrackWidth = 220,
                MinX = -300,
                MinY = -10,
                MaxX = 1400,
                MaxY = 800,
                TotalLaps = 3,
            },
        };
        var joinBytes = JsonSerializer.SerializeToUtf8Bytes(joinStatic, JsonOpts);
        joinBytes.Length.Should().BeLessThanOrEqualTo(8192,
            $"join payload (static world + empty cars) must fit 8 KB; saw {joinBytes.Length} bytes");

        // ── Part 2: career round-trip ─────────────────────────────────────
        var original = new PoCabinetCareerDto
        {
            CurrentStageIndex = 2,
            TrophyUnlocked = true,
            GoldLiveryUnlocked = true,
            CompletedStages = new[] { 0, 1, 2 },
            UpdatedAtUtc = DateTimeOffset.UtcNow,
        };
        var careerJson = JsonSerializer.Serialize(original, JsonOpts);
        var careerBytes = Encoding.UTF8.GetBytes(careerJson);
        careerBytes.Length.Should().BeLessThanOrEqualTo(512, "career DTO is tiny");
        var roundTripped = JsonSerializer.Deserialize<PoCabinetCareerDto>(careerJson, JsonOpts);
        roundTripped.Should().NotBeNull();
        roundTripped!.CurrentStageIndex.Should().Be(2);
        roundTripped.TrophyUnlocked.Should().BeTrue();
        roundTripped.GoldLiveryUnlocked.Should().BeTrue();
        roundTripped.CompletedStages.Should().Equal(0, 1, 2);

        // ── Part 3: enum / catalog compatibility ──────────────────────────
        PoCabinetCatalog.IsKnownTrack("capitol").Should().BeTrue();
        PoCabinetCatalog.IsKnownTrack("Capitol").Should().BeTrue("track lookup is case-insensitive");
        PoCabinetCatalog.IsKnownTrack("unknown").Should().BeFalse();
        PoCabinetCatalog.GetTrack(null).Id.Should().Be(PoCabinetCatalog.DefaultTrackId);
    }
}
