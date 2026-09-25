using System.Collections.Concurrent;
using FluentAssertions;
using Microsoft.Extensions.Time.Testing;
using PoMiniGames.AI;
using PoMiniGames.Features.PoJevArena;
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
    public async Task CallAllowance_AndMatchRegistry_Contracts(string scenario)
    {
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 9, 25, 23, 58, 0, TimeSpan.Zero));
        var store = new MemoryLedgerStore();
        var allowance = NewAllowance(limit: 100, clock, store);

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
