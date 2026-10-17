using FluentAssertions;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGames.Unit.Features.Shared;

/// <summary>
/// The hub's Today card: the pick is a pure function of the UTC day over offline-capable solo
/// games, seeded games get <c>?daily=yyyyMMdd</c>, and the cross-game streak grows, holds and
/// resets by calendar day. One method, because the Unit tier is near its ceiling.
/// </summary>
public class DailyChallengeServiceTests
{
    [Fact]
    public void Pick_IsStablePerUtcDay_AndStreakFollowsTheCalendar()
    {
        var morning = new DateTime(2026, 10, 17, 0, 5, 0, DateTimeKind.Utc);
        var night = new DateTime(2026, 10, 17, 23, 55, 0, DateTimeKind.Utc);

        var pick = DailyChallengeService.PickFor(morning);
        DailyChallengeService.PickFor(night).Should().Be(pick, "everyone gets one pick per UTC day");
        pick.Day.Should().Be(20261017);
        DailyChallengeService.Pool.Should().Contain(pick.Game);
        DailyChallengeService.Pool.Select(g => g.Find(GameMode.OnePlayer)?.RequiresNetwork)
            .Should().OnlyContain(needsNetwork => needsNetwork == false, "the Today card has to work offline");
        pick.Url.Should().StartWith(pick.Mode.Url);
        if (pick.Seeded) pick.Url.Should().EndWith("daily=20261017");

        // A month of picks should not all land on one game.
        Enumerable.Range(0, 30).Select(d => DailyChallengeService.PickFor(morning.AddDays(d)).Game.Key)
            .Distinct().Count().Should().BeGreaterThan(3);

        var first = DailyChallengeService.Advance(default, morning);
        first.Should().Be(new DailyStreak(20261017, 1, 1));
        DailyChallengeService.Advance(first, night).Should().Be(first, "a second launch the same day counts once");

        var second = DailyChallengeService.Advance(first, morning.AddDays(1));
        second.Should().Be(new DailyStreak(20261018, 2, 2));
        DailyChallengeService.LiveStreak(second, morning.AddDays(2)).Should().Be(2, "yesterday still counts");
        DailyChallengeService.LiveStreak(second, morning.AddDays(3)).Should().Be(0, "a missed day ends it");

        DailyChallengeService.Advance(second, morning.AddDays(4)).Should().Be(new DailyStreak(20261021, 1, 2),
            "a gap restarts the run but keeps the best");
    }
}
