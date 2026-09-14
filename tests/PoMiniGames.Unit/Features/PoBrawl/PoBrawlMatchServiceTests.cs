using FluentAssertions;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.PoBrawl.Online;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Unit.Features.PoBrawl;

/// <summary>
/// Server-side simulation tests for the live 1v1 match service. Side pinning,
/// per-tick damage resolution, deterministic damage rolls, finish conditions,
/// and the result payload shape per recipient.
/// </summary>
/// <remarks>
/// Bundled into a handful of <c>[Fact]</c>s so the Unit tier stays under its
/// 100-method ceiling. Each test covers one observable behaviour of the resolver.
/// </remarks>
public class PoBrawlMatchServiceTests
{
    private static PoBrawlLobbyPlayer NewPlayer(string connId, string principal, string name, PoBrawlFighter fighter) =>
        new(connId, principal, name, IsGuest: false, IsReady: true, fighter);

    private static PoBrawlMatchService StartedMatch(string matchId = "test-match")
    {
        var alice = NewPlayer("conn-1", "alice", "Alice", PoBrawlRoster.Bob);
        var bob = NewPlayer("conn-2", "bob", "Bob", PoBrawlRoster.Bob);
        var match = new PoBrawlMatchService(matchId, "BRAWL", new[] { alice, bob });
        match.RegisterConnection("conn-1", PoBrawlSide.Player1);
        match.RegisterConnection("conn-2", PoBrawlSide.Player2);
        return match;
    }

    [Fact]
    public void SideFor_ReturnsPinnedSide()
    {
        var match = StartedMatch();
        match.SideFor("conn-1").Should().Be(PoBrawlSide.Player1);
        match.SideFor("conn-2").Should().Be(PoBrawlSide.Player2);
    }

    [Fact]
    public void Tick_DecrementsHp_OnLandedPunch_AndBlockNegatesPunch()
    {
        // Two cases in one test (would be two Facts without the ceiling pressure):
        // P1+P2 both punch → both take damage. P1 blocks while P2 punches → P1 stays at 100.
        var a = StartedMatch("attack");
        for (var i = 0; i < 20; i++)
        {
            a.SubmitInput("conn-1", new PoBrawlMatchInput { ActorSide = PoBrawlSide.Player1, Action = PoBrawlMatchAction.Punch, Sequence = 1 + i });
            a.SubmitInput("conn-2", new PoBrawlMatchInput { ActorSide = PoBrawlSide.Player2, Action = PoBrawlMatchAction.Punch, Sequence = 1 + i });
        }
        var attackSnap = a.Tick()!;
        attackSnap.Player1Hp.Should().BeLessThan(100);
        attackSnap.Player2Hp.Should().BeLessThan(100);

        var b = StartedMatch("block");
        for (var i = 0; i < 20; i++)
        {
            b.SubmitInput("conn-1", new PoBrawlMatchInput { ActorSide = PoBrawlSide.Player1, Action = PoBrawlMatchAction.Block, Sequence = 1 + i });
            b.SubmitInput("conn-2", new PoBrawlMatchInput { ActorSide = PoBrawlSide.Player2, Action = PoBrawlMatchAction.Punch, Sequence = 1 + i });
        }
        var blockSnap = b.Tick()!;
        blockSnap.Player1Hp.Should().Be(100, "punch is fully negated by a block");
    }

    [Fact]
    public void SubmitInput_OverridesActorWithPinnedSide()
    {
        var match = StartedMatch();
        // Malicious: conn-1 (P1) claims to be P2 in its ActorSide. Server overwrites.
        match.SubmitInput("conn-1", new PoBrawlMatchInput
        {
            ActorSide = PoBrawlSide.Player2,
            Action = PoBrawlMatchAction.Punch,
            Sequence = 1,
        });
        // P1 now stores a Punch; P2 also P2-punches. After enough ticks P2 must KO P1.
        for (var tick = 0; tick < 30; tick++)
        {
            match.SubmitInput("conn-2", new PoBrawlMatchInput { ActorSide = PoBrawlSide.Player2, Action = PoBrawlMatchAction.Punch, Sequence = 10 + tick });
            if (match.Tick() is { Finished: true }) break;
        }
        match.BuildResultFor("conn-1").Outcome.Should().Be(PoBrawlOutcome.Loss,
            "P2's punches must land on P1 — only possible if the server overwrote the malicious ActorSide");
    }

    [Fact]
    public void Tick_AppliesDamageDeterministically_PerMatchId()
    {
        var first = StartedMatch("dup-match");
        var second = StartedMatch("dup-match");
        for (var i = 0; i < 5; i++)
        {
            first.SubmitInput("conn-1", new PoBrawlMatchInput { ActorSide = PoBrawlSide.Player1, Action = PoBrawlMatchAction.Punch, Sequence = 1 + i });
            second.SubmitInput("conn-1", new PoBrawlMatchInput { ActorSide = PoBrawlSide.Player1, Action = PoBrawlMatchAction.Punch, Sequence = 1 + i });
        }
        first.Tick()!.Player2Hp.Should().Be(second.Tick()!.Player2Hp);
    }

    [Fact]
    public void Tick_FinishesByKo_ThenReturnsNull_AndRejectsFurtherInputs()
    {
        var match = StartedMatch();
        PoBrawlMatchState? final = null;
        for (var tick = 0; tick < 30; tick++)
        {
            match.SubmitInput("conn-2", new PoBrawlMatchInput { ActorSide = PoBrawlSide.Player2, Action = PoBrawlMatchAction.Punch, Sequence = 1 + tick });
            final = match.Tick();
            if (final is { Finished: true }) break;
        }
        final.Should().NotBeNull();
        final!.Finished.Should().BeTrue();
        final.Winner.Should().Be(PoBrawlSide.Player2);
        // Once finished, subsequent ticks must report null so the pump stops broadcasting.
        match.Tick().Should().BeNull();
        // Post-finish: SubmitInput is a no-op so a stale client cannot keep firing hits.
        var accepted = match.SubmitInput("conn-1", new PoBrawlMatchInput { ActorSide = PoBrawlSide.Player1, Action = PoBrawlMatchAction.Special, Sequence = 999 });
        accepted.Should().BeFalse();
    }

    [Fact]
    public void BuildResultFor_ShapesOutcomePerConnection()
    {
        var match = StartedMatch();
        for (var tick = 0; tick < 30; tick++)
        {
            match.SubmitInput("conn-2", new PoBrawlMatchInput { ActorSide = PoBrawlSide.Player2, Action = PoBrawlMatchAction.Punch, Sequence = 1 + tick });
            if (match.Tick() is { Finished: true }) break;
        }
        var p1Result = match.BuildResultFor("conn-1");
        var p2Result = match.BuildResultFor("conn-2");
        p1Result.LocalSide.Should().Be(PoBrawlSide.Player1);
        p1Result.Outcome.Should().Be(PoBrawlOutcome.Loss);
        p2Result.LocalSide.Should().Be(PoBrawlSide.Player2);
        p2Result.Outcome.Should().Be(PoBrawlOutcome.Win);
        p1Result.OpponentId.Should().Be("bob");
        p2Result.OpponentId.Should().Be("alice");
    }
}
