using System.Collections.Concurrent;
using FluentAssertions;
using Microsoft.Extensions.Time.Testing;
using PoMiniGames.AI;
using PoMiniGames.Features.PoJevArena;
using PoMiniGames.Shared.Games.PoJevArena;
using Xunit;

namespace PoMiniGames.Unit.Features.PoJevArena;

/// <summary>
/// The two server-held trust contracts: the durable per-identity daily Jev call cap (a batch is
/// admitted whole or not at all, resets at UTC midnight, survives a restart), and the match
/// registry that gates result reporting.
/// </summary>
public sealed class ArenaContractsTests
{
    private const string Me = "id:player-1";

    [Theory]
    [InlineData("allowance-under-limit")]
    [InlineData("allowance-exact-limit")]
    [InlineData("allowance-batch-rejected-whole")]
    [InlineData("allowance-utc-rollover")]
    [InlineData("allowance-survives-restart")]
    [InlineData("allowance-identities-independent")]
    [InlineData("registry-owner-only")]
    [InlineData("registry-result-one-shot")]
    [InlineData("registry-result-needs-paid-decisions")]
    [InlineData("registry-result-must-be-plausible")]
    [InlineData("registry-sliding-expiry")]
    [InlineData("registry-roster-frozen")]
    public async Task CallAllowance_AndMatchRegistry_Contracts(string scenario)
    {
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 9, 25, 23, 58, 0, TimeSpan.Zero));
        var store = new MemoryLedgerStore();
        var allowance = NewAllowance(limit: 100, clock, store);
        var registry = new ArenaMatchRegistry(clock);
        var roster = new ArenaRoster(
            [.. Enumerable.Repeat(PoJevArenaCatalog.Presets[0], 10)],
            [.. Enumerable.Repeat(PoJevArenaCatalog.Presets[1], 10)]);

        switch (scenario)
        {
            case "registry-owner-only":
                {
                    var match = registry.Register(Me, roster, ArenaMode.OnePlayer);
                    registry.Find(match.MatchId, Me).Should().BeSameAs(match);
                    registry.Find(match.MatchId, "id:someone-else").Should().BeNull("another identity must not see or drive my match");
                    registry.Find("no-such-match", Me).Should().BeNull();
                    return;
                }
            case "registry-result-one-shot":
                {
                    var match = registry.Register(Me, roster, ArenaMode.OnePlayer);
                    match.RecordDecisions(ArenaMatchRegistry.MinDecisionsForResult, costUsd: 0.001);
                    clock.Advance(TimeSpan.FromSeconds(10));
                    match.TryClaimResult(10, clock.GetUtcNow()).Should().Be(ArenaResultGate.Accepted);
                    match.TryClaimResult(10, clock.GetUtcNow()).Should().Be(ArenaResultGate.AlreadyReported);
                    // A failed stats write hands the claim back, so the retry is not a 409.
                    match.ReleaseResultClaim();
                    match.TryClaimResult(10, clock.GetUtcNow()).Should().Be(ArenaResultGate.Accepted);
                    return;
                }
            case "registry-result-needs-paid-decisions":
                {
                    var match = registry.Register(Me, roster, ArenaMode.OnePlayer);
                    clock.Advance(TimeSpan.FromSeconds(60));
                    match.RecordDecisions(ArenaMatchRegistry.MinDecisionsForResult - 1, costUsd: 0);
                    match.TryClaimResult(10, clock.GetUtcNow()).Should().Be(ArenaResultGate.TooFewDecisions,
                        "stats cannot be inflated without spending real Jev decisions");
                    match.RecordDecisions(1, costUsd: 0);
                    match.TryClaimResult(60, clock.GetUtcNow()).Should().Be(ArenaResultGate.TooFewDecisions,
                        "a 60 s claim needs decisions in proportion to its length");
                    match.RecordDecisions(200, costUsd: 0);
                    match.TryClaimResult(60, clock.GetUtcNow()).Should().Be(ArenaResultGate.Accepted);
                    return;
                }
            case "registry-result-must-be-plausible":
                {
                    var match = registry.Register(Me, roster, ArenaMode.OnePlayer);
                    match.RecordDecisions(1_000, costUsd: 0);
                    clock.Advance(TimeSpan.FromSeconds(5));
                    match.TryClaimResult(120, clock.GetUtcNow()).Should().Be(ArenaResultGate.Implausible,
                        "a 2-minute match cannot finish 5 s after it was registered");
                    match.TryClaimResult(4, clock.GetUtcNow()).Should().Be(ArenaResultGate.Implausible,
                        "a result needs a minimum match length");
                    return;
                }
            case "registry-sliding-expiry":
                {
                    var match = registry.Register(Me, roster, ArenaMode.OnePlayer);
                    clock.Advance(TimeSpan.FromMinutes(10));
                    registry.Find(match.MatchId, Me).Should().NotBeNull("each lookup slides the expiry");
                    clock.Advance(TimeSpan.FromMinutes(10));
                    registry.Find(match.MatchId, Me).Should().NotBeNull();
                    clock.Advance(ArenaMatchRegistry.IdleExpiry + TimeSpan.FromSeconds(1));
                    registry.Find(match.MatchId, Me).Should().BeNull("an idle match expires");
                    return;
                }
            case "registry-roster-frozen":
                {
                    var a = registry.Register(Me, roster, ArenaMode.Demo);
                    var b = registry.Register(Me, roster, ArenaMode.Demo);
                    a.MatchId.Should().NotBe(b.MatchId);
                    a.Roster.Should().BeSameAs(roster);
                    a.Mode.Should().Be(ArenaMode.Demo);
                    return;
                }
        }

        switch (scenario)
        {
            case "allowance-under-limit":
                {
                    var verdict = await allowance.CheckAsync(Me, calls: 5);
                    verdict.Allowed.Should().BeTrue();
                    allowance.Record(Me, 5);
                    (await allowance.CheckAsync(Me, 0)).Used.Should().Be(5);
                    (await allowance.CheckAsync(Me, 0)).Remaining.Should().Be(95);
                    break;
                }
            case "allowance-exact-limit":
                {
                    allowance.Record(Me, 95);
                    (await allowance.CheckAsync(Me, calls: 5)).Allowed.Should().BeTrue("95 + 5 lands exactly on the cap");
                    allowance.Record(Me, 5);
                    var spent = await allowance.CheckAsync(Me, calls: 1);
                    spent.Allowed.Should().BeFalse();
                    spent.Remaining.Should().Be(0);
                    break;
                }
            case "allowance-batch-rejected-whole":
                {
                    allowance.Record(Me, 97);
                    var verdict = await allowance.CheckAsync(Me, calls: 5);
                    verdict.Allowed.Should().BeFalse("a 5-unit batch with 3 calls left is refused whole, not trimmed");
                    verdict.Remaining.Should().Be(3);
                    verdict.ResetUtc.Should().Be(new DateTimeOffset(2026, 9, 26, 0, 0, 0, TimeSpan.Zero));
                    break;
                }
            case "allowance-utc-rollover":
                {
                    allowance.Record(Me, 100);
                    (await allowance.CheckAsync(Me, 1)).Allowed.Should().BeFalse();
                    // The 30 s flusher runs well before midnight; unflushed spend would (deliberately,
                    // see AiTokenBudget.Record) be re-attributed to the new day instead of forgiven.
                    await allowance.Budget.FlushAsync();
                    clock.Advance(TimeSpan.FromMinutes(3));
                    var fresh = await allowance.CheckAsync(Me, 1);
                    fresh.Allowed.Should().BeTrue("the allowance returns at 00:00 UTC");
                    fresh.Used.Should().Be(0);
                    break;
                }
            case "allowance-survives-restart":
                {
                    allowance.Record(Me, 60);
                    await allowance.Budget.FlushAsync();
                    var afterRestart = NewAllowance(limit: 100, clock, store);
                    (await afterRestart.CheckAsync(Me, 0)).Used.Should().Be(60, "a recycled host rehydrates from the ledger");
                    (await afterRestart.CheckAsync(Me, 41)).Allowed.Should().BeFalse();
                    break;
                }
            case "allowance-identities-independent":
                {
                    allowance.Record(Me, 100);
                    (await allowance.CheckAsync("id:player-2", 10)).Allowed.Should().BeTrue();
                    break;
                }
            default:
                throw new ArgumentOutOfRangeException(nameof(scenario), scenario, null);
        }
    }

    private static JevCallAllowance NewAllowance(long limit, FakeTimeProvider clock, IAiTokenLedgerStore store) =>
        new(new AiTokenBudget(limit, clock.GetUtcNow, store));

    /// <summary>In-memory durable store: what a second host instance would read back.</summary>
    private sealed class MemoryLedgerStore : IAiTokenLedgerStore
    {
        private readonly ConcurrentDictionary<(DateOnly, string), long> _rows = new();

        public bool IsDurable => true;

        public Task<long> LoadAsync(DateOnly day, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(_rows.GetValueOrDefault((day, identity)));

        public Task IncrementAsync(DateOnly day, string identity, long delta, CancellationToken cancellationToken = default)
        {
            _rows.AddOrUpdate((day, identity), delta, (_, v) => v + delta);
            return Task.CompletedTask;
        }
    }
}
