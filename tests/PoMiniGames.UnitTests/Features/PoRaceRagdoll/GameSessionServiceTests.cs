using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PoMiniGames.Features.PoRaceRagdoll;

namespace PoMiniGames.UnitTests.Features.PoRaceRagdoll;

/// <summary>
/// Unit tests for the PoRaceRagdoll session state machine. The race winner is
/// normally weighted-random, so these tests inject a single-racer
/// <see cref="FakeRacerService"/> (winner is therefore deterministic) and a
/// controllable <see cref="TestTimeProvider"/> to exercise the stale-race refund.
/// No I/O — pure in-memory logic.
/// </summary>
public sealed class GameSessionServiceTests
{
    private static GameSessionService NewService(out TestTimeProvider clock, out FakeRacerService racers)
    {
        clock = new TestTimeProvider(new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero));
        racers = new FakeRacerService();
        return new GameSessionService(racers, NullLogger<GameSessionService>.Instance, clock);
    }

    [Fact]
    public void CreateSession_StartsInBettingPhaseWithInitialBalance()
    {
        var svc = NewService(out _, out _);

        var id = svc.CreateSession();
        var state = svc.GetSession(id);

        state.Should().NotBeNull();
        state!.Balance.Should().Be(GameConfig.InitialBalance);
        state.Round.Should().Be(1);
        state.MaxRounds.Should().Be(GameConfig.TotalRounds);
        state.State.Should().Be(GamePhase.Betting);
        state.BetAmount.Should().Be(GameConfig.InitialBet);
    }

    [Fact]
    public void GetSession_ReturnsNull_ForUnknownId()
    {
        var svc = NewService(out _, out _);
        svc.GetSession("does-not-exist").Should().BeNull();
    }

    [Fact]
    public void PlaceBet_DeductsBalanceAndMovesToRacing_OnSuccess()
    {
        var svc = NewService(out _, out _);
        var id = svc.CreateSession();

        var (state, outcome) = svc.PlaceBet(id, racerId: 0);

        outcome.Should().Be(PlaceBetOutcome.Success);
        state!.State.Should().Be(GamePhase.Racing);
        state.Balance.Should().Be(GameConfig.InitialBalance - GameConfig.InitialBet);
        state.SelectedRacerId.Should().Be(0);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(99)]
    public void PlaceBet_RejectsOutOfRangeRacer(int racerId)
    {
        var svc = NewService(out _, out _);
        var id = svc.CreateSession();

        var (_, outcome) = svc.PlaceBet(id, racerId);

        outcome.Should().Be(PlaceBetOutcome.InvalidRacer);
    }

    [Fact]
    public void PlaceBet_RejectsWhenNotInBettingPhase()
    {
        var svc = NewService(out _, out _);
        var id = svc.CreateSession();
        svc.PlaceBet(id, 0); // -> Racing

        var (_, outcome) = svc.PlaceBet(id, 0);

        outcome.Should().Be(PlaceBetOutcome.WrongPhase);
    }

    [Fact]
    public void PlaceBet_ReturnsNotFound_ForUnknownSession()
    {
        var svc = NewService(out _, out _);
        var (state, outcome) = svc.PlaceBet("nope", 0);

        state.Should().BeNull();
        outcome.Should().Be(PlaceBetOutcome.NotFound);
    }

    [Fact]
    public void FinishRace_PaysOutAndFinishes_WhenPlayerBacksTheLoneRacer()
    {
        var svc = NewService(out _, out var racers);
        var id = svc.CreateSession();
        svc.PlaceBet(id, 0);

        var (state, result) = svc.FinishRace(id);

        result.Should().NotBeNull();
        result!.PlayerWon.Should().BeTrue();          // only one racer can win
        result.WinnerId.Should().Be(0);
        result.Payout.Should().Be(racers.PayoutWhenWon);
        state!.State.Should().Be(GamePhase.Finished);
        // 1000 - 100 bet + payout
        state.Balance.Should().Be(GameConfig.InitialBalance - GameConfig.InitialBet + racers.PayoutWhenWon);
        result.NewBalance.Should().Be(state.Balance);
    }

    [Fact]
    public void NextRound_AdvancesRoundAndResetsToBetting()
    {
        var svc = NewService(out _, out _);
        var id = svc.CreateSession();
        svc.PlaceBet(id, 0);
        svc.FinishRace(id);

        var state = svc.NextRound(id);

        state!.Round.Should().Be(2);
        state.State.Should().Be(GamePhase.Betting);
        state.SelectedRacerId.Should().BeNull();
        state.WinnerId.Should().BeNull();
    }

    [Fact]
    public void GetSession_RefundsAndResets_WhenRaceExceedsTimeout()
    {
        var svc = NewService(out var clock, out _);
        var id = svc.CreateSession();
        svc.PlaceBet(id, 0); // Racing; balance now 900

        clock.Advance(TimeSpan.FromMinutes(6)); // race timeout is 5 minutes
        var state = svc.GetSession(id);

        state!.State.Should().Be(GamePhase.Betting);
        state.Balance.Should().Be(GameConfig.InitialBalance); // bet refunded
        state.SelectedRacerId.Should().BeNull();
    }

    private sealed class FakeRacerService : IRacerService
    {
        public int PayoutWhenWon { get; } = 250;

        public IReadOnlyList<RacerSpecies> GetAvailableSpecies() => [];

        // A single racer with an overwhelming favourite weight: PickServerWinner is
        // therefore deterministic (Id 0 always wins).
        public IReadOnlyList<Racer> GenerateRacers() =>
            [new Racer(0, "Solo", "snail", "racer", "red", 1.0, Odds: -100000)];

        public int CalculatePayout(int betAmount, int odds, bool playerWon) =>
            playerWon ? PayoutWhenWon : 0;
    }

    private sealed class TestTimeProvider(DateTimeOffset start) : TimeProvider
    {
        private DateTimeOffset _now = start;
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan delta) => _now += delta;
    }
}
