using System.Reflection;
using FluentAssertions;
using PoMiniGames.Domain.Models;

namespace PoMiniGames.Integration;

/// <summary>
/// Behavioral pins for the PoSports storage descriptor: sanitize clamps, the
/// lower-time ratchet, player-identity row keys, and ascending rank. Lives in the
/// Integration tier (storage-shaped coverage; the Unit tier is at its 100-method
/// ceiling). The structural rules that apply to every board — RowKeyFields exist in
/// ToFields, a default entry maps without throwing — are covered by discovery in the
/// Unit tier's HighScoreDescriptorTests, which see this descriptor automatically.
/// </summary>
public sealed class PoSportsHighScoreDescriptorTests
{
    private static readonly object Descriptor = Load();

    private static object Load()
    {
        var storage = typeof(PoMiniGames.Infrastructure.Services.StorageService);
        var field = storage.GetField("PoSportsScores", BindingFlags.NonPublic | BindingFlags.Static);
        field.Should().NotBeNull("StorageService must declare the PoSportsScores descriptor");
        return field!.GetValue(null)!;
    }

    private static PoSportsHighScore Sanitize(PoSportsHighScore e)
    {
        var f = (Delegate)Descriptor.GetType().GetProperty("Sanitize")!.GetValue(Descriptor)!;
        return (PoSportsHighScore)f.DynamicInvoke(e)!;
    }

    [Fact]
    public void Sanitize_ClampsRanges_TruncatesName_DefaultsDate()
    {
        var dirty = new PoSportsHighScore
        {
            PlayerName = new string('x', 60),
            TotalTimeSeconds = 99999,
            SprintSeconds = -5,
            HurdlesClean = 42,
            Character = "mom",
        };

        var clean = Sanitize(dirty);

        clean.PlayerName.Length.Should().BeLessThanOrEqualTo(24);
        clean.TotalTimeSeconds.Should().Be(600);
        clean.SprintSeconds.Should().Be(0);
        clean.HurdlesClean.Should().Be(8);
        clean.Date.Should().NotBeNullOrEmpty("sanitize must default a missing date");
    }

    [Fact]
    public void RowKey_IsPlayerIdentity_And_RankIsAscending()
    {
        var fields = (IReadOnlyList<string>)Descriptor.GetType()
            .GetProperty("RowKeyFields")!.GetValue(Descriptor)!;
        fields.Should().BeEquivalentTo(["PlayerName", "UserId", "IsGuest"],
            "one row per player; a score-keyed board would let one player fill it");

        var rank = (Delegate)Descriptor.GetType().GetProperty("Rank")!.GetValue(Descriptor)!;
        var ranked = ((IEnumerable<PoSportsHighScore>)rank.DynamicInvoke(new[]
        {
            new PoSportsHighScore { PlayerName = "Slow", TotalTimeSeconds = 60, Date = "2026-01-01" },
            new PoSportsHighScore { PlayerName = "Fast", TotalTimeSeconds = 30, Date = "2026-01-02" },
            new PoSportsHighScore { PlayerName = "Mid", TotalTimeSeconds = 45, Date = "2026-01-03" },
        }.AsEnumerable())!).ToList();
        ranked.Select(r => r.PlayerName).Should().Equal("Fast", "Mid", "Slow");
    }

    [Fact]
    public void ShouldOverwrite_OnlyAcceptsStrictlyFasterMeets()
    {
        var shouldOverwrite = (Delegate?)Descriptor.GetType()
            .GetProperty("ShouldOverwrite")!.GetValue(Descriptor);
        shouldOverwrite.Should().NotBeNull("without a ratchet a slower meet would erase a PB");

        var existing = new Azure.Data.Tables.TableEntity { ["TotalTimeSeconds"] = 40.0 };
        var faster = new Dictionary<string, object?> { ["TotalTimeSeconds"] = 35.0 };
        var slower = new Dictionary<string, object?> { ["TotalTimeSeconds"] = 45.0 };
        var equal = new Dictionary<string, object?> { ["TotalTimeSeconds"] = 40.0 };

        ((bool)shouldOverwrite!.DynamicInvoke(existing, faster)!).Should().BeTrue();
        ((bool)shouldOverwrite.DynamicInvoke(existing, slower)!).Should().BeFalse();
        ((bool)shouldOverwrite.DynamicInvoke(existing, equal)!).Should().BeFalse("ties keep the older row");
    }
}
