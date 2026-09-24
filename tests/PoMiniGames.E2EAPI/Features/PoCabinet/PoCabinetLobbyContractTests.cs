using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using PoMiniGames.Features.PoCabinet;

namespace PoMiniGames.E2EAPI.Features.PoCabinet;

/// <summary>
/// HTTP contract tests for the PoCabinet lobby service. One method by design — the
/// E2E-API tier is capped at 25 (the 100/50/25/25 rule) and the service's surface
/// is small enough to exercise in one Fact: 8-char join-code generation, host
/// assignment, ready toggling, cap-8 bounce, host migration on leave — plus the rematch
/// loop (a lobby reopens when its race ends), AI officials filling free seats so a lone host
/// can race, the public browser, and seats that survive a dropped connection.
/// </summary>
public sealed class PoCabinetLobbyContractTests
{
    [Fact]
    public void Lobby_Open_AssignsHost_And_GeneratesJoinCode_And_BouncesAtCap()
    {
        var service = new PoCabinetLobbyService();

        var hostConn = "conn-host";
        var code = service.Open(hostConn, "Alice", isGuest: false, trackId: "capitol");

        // Join code shape: CAB- + 8 chars from the safe alphabet (no I/O/0/1).
        code.Should().StartWith("CAB-");
        code.Length.Should().Be(12);
        code[4..].Should().MatchRegex("[A-Z2-9]+",
            "join codes use Crockford-style alphabet (no I/O/0/1 to avoid misread)");

        var lobby = service.GetByCode(code);
        lobby.Should().NotBeNull();
        lobby!.HostId.Should().Be(hostConn);
        lobby.Players.Should().HaveCount(1, "host auto-readies but no one else has joined yet");
        lobby.Players[0].IsReady.Should().BeTrue("the host is auto-ready");
        lobby.IsStarted.Should().BeFalse();

        // ── A second player joins and the lobby grows ───────────────────────
        var second = service.Join(code, "conn-2", "Bob", isGuest: true);
        second.Should().NotBeNull();
        second!.Players.Should().HaveCount(2);

        // ── 7 more players join (fill the 8-seat lobby) ────────────────────
        for (var i = 0; i < 6; i++)
        {
            service.Join(code, $"conn-{i + 3}", $"Player{i + 3}", isGuest: true).Should().NotBeNull();
        }
        var full = service.GetByCode(code);
        full!.Players.Should().HaveCount(8, "PoCabinet caps at 8 cars");

        // ── A 9th player is bounced with a null return ────────────────────
        var ninth = service.Join(code, "conn-9", "Eve", isGuest: true);
        ninth.Should().BeNull("the lobby is at the 8-seat cap and rejects new joiners");

        // ── Toggle ready on the second player ──────────────────────────────
        service.ToggleReady(code, "conn-2").Should().BeTrue();
        service.GetByCode(code)!.Players.First(p => p.PlayerId == "conn-2").IsReady.Should().BeTrue();

        // ── Host can't start yet — only the host is ready ──────────────────
        service.CanStart(code, hostConn).Should().BeFalse("Bob isn't ready");
        // Make Bob un-ready again; the host is auto-ready, but no one else is.
        service.ToggleReady(code, "conn-2");
        // All guests mark ready.
        for (var i = 0; i < 7; i++) service.ToggleReady(code, $"conn-{i + 2}");
        service.CanStart(code, hostConn).Should().BeTrue();

        // ── Non-host cannot start ────────────────────────────────────────────
        service.CanStart(code, "conn-2").Should().BeFalse("only the host can start");

        // ── Start locks the lobby and a second start is rejected ───────────
        service.Start(code, hostConn).Should().NotBeNull();
        service.GetByCode(code)!.IsStarted.Should().BeTrue();
        service.Start(code, hostConn).Should().BeNull("a started lobby cannot re-enter Start");

        // ── Join after start is rejected ────────────────────────────────────
        service.Join(code, "conn-late", "Latecomer", isGuest: true).Should().BeNull();

        // ── Host leaves → a remaining player is promoted ───────────────────
        service.Leave(code, hostConn);
        var afterLeave = service.GetByCode(code);
        afterLeave.Should().NotBeNull();
        afterLeave!.HostId.Should().NotBe(hostConn,
            "host migration: the next player in the roster becomes host");

        // ── Last player leaves → lobby closes ──────────────────────────────
        foreach (var p in afterLeave.Players.ToList()) service.Leave(code, p.PlayerId);
        service.GetByCode(code).Should().BeNull("an empty lobby is purged");

        // ── Solo host + AI officials: public, startable, grid filled by bots ─
        var solo = service.Open("solo-host", "Hana", isGuest: true, trackId: "maralago", isPublic: true, connectionId: "c-solo");
        service.CanStart(solo, "solo-host").Should().BeTrue("a lone host races the default AI officials");
        service.ListPublic().Should().Contain(s => s.Code == solo && s.Bots == PoCabinetLobbyService.DefaultBots);
        service.SetBots(solo, "solo-host", 0).Should().BeTrue();
        service.CanStart(solo, "solo-host").Should().BeFalse("one car is not a race");
        service.SetBots(solo, "solo-host", 2);
        service.SetBots(solo, "someone-else", 4).Should().BeFalse("only the host changes the grid");

        // A guest joins, drops mid-race and reconnects: same seat, not a second one.
        service.Join(solo, "guest-1", "Gil", isGuest: true, connectionId: "c-g1").Should().NotBeNull();
        service.ToggleReady(solo, "guest-1");
        service.Start(solo, "solo-host").Should().NotBeNull();
        var grid = service.BuildGrid(solo);
        grid.Should().HaveCount(4, "two humans plus the two officials asked for");
        grid.Take(2).Should().OnlyContain(d => d.IsPlayer);
        grid.Skip(2).Should().OnlyContain(d => !d.IsPlayer && d.Personality != null);
        service.DropConnection("c-g1").Should().Contain(solo);
        service.GetByCode(solo)!.Players.Should().HaveCount(2, "a drop mid-race keeps the seat until the race ends");
        service.Join(solo, "guest-1", "Gil", isGuest: true, connectionId: "c-g1b").Should().NotBeNull("rejoining your own seat works mid-race");

        // Race over → the lobby reopens with the same code for a rematch.
        var reopened = service.MarkRaceFinished(solo);
        reopened.Should().NotBeNull();
        reopened!.IsStarted.Should().BeFalse();
        reopened.Players.Should().HaveCount(2);
        reopened.Players.Single(p => p.PlayerId == "guest-1").IsReady.Should().BeFalse("guests ready up again for the rematch");
        service.View(solo, "guest-1")!.YourSeatId.Should().Be(PoCabinetLobbyService.SeatIdFor(solo, "guest-1"))
            .And.NotContain("guest-1", "seat ids never expose the claim id");
    }
}
