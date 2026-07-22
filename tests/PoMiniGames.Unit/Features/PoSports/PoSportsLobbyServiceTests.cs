using FluentAssertions;
using PoMiniGames.Features.PoSports;

namespace PoMiniGames.Unit.Features.PoSports;

/// <summary>
/// Exercises the global-lobby rules directly: host claim, the first-come character
/// lock, the ready/start gate, and drain-reset — the invariants the lobby hub depends
/// on but that shouldn't need a SignalR connection to prove. Scenarios are grouped per
/// flow (not one fact per assert) to respect the Unit tier's 100-method ceiling.
/// </summary>
public class PoSportsLobbyServiceTests
{
    private readonly PoSportsLobbyService _lobby = new();

    [Fact]
    public void JoinFlow_HostClaim_Capacity_And_NameSanitize()
    {
        // First arrival becomes host.
        var (state, msg) = _lobby.Open("c1", "Alice", isGuest: true);
        state.HostConnectionId.Should().Be("c1");
        state.Members.Should().ContainSingle(m => m.DisplayName == "Alice");
        msg.Should().Be("Alice joined");

        // Long names are truncated to the shared 24-char display width.
        var (s2, _) = _lobby.Open("c2", new string('x', 40), true);
        s2.Members.Single(m => m.ConnectionId == "c2").DisplayName.Should().HaveLength(24);

        // A fifth arrival is rejected — four lanes on the track.
        _lobby.Open("c3", "P3", true);
        _lobby.Open("c4", "P4", true);
        var (s5, m5) = _lobby.Open("c5", "P5", true);
        m5.Should().Be("Lobby is full");
        s5.Members.Should().HaveCount(4);
    }

    [Fact]
    public void CharacterLock_FirstComeRules()
    {
        _lobby.Open("c1", "Alice", true);
        _lobby.Open("c2", "Bob", true);

        // First claim wins; the second claimant is denied.
        _lobby.PickCharacter("c1", "dad").ok.Should().BeTrue();
        var (ok, msg) = _lobby.PickCharacter("c2", "dad");
        ok.Should().BeFalse();
        msg.Should().Be("dad is taken");

        // Re-picking your own character is a no-op success.
        _lobby.PickCharacter("c1", "dad").ok.Should().BeTrue();

        // Switching releases the old lock for others.
        _lobby.PickCharacter("c1", "tong").ok.Should().BeTrue();
        _lobby.PickCharacter("c2", "dad").ok.Should().BeTrue();

        // Unknown keys are rejected outright.
        _lobby.PickCharacter("c1", "gizmo").ok.Should().BeFalse();
    }

    [Fact]
    public void StartGate_HostMigration_And_LifecycleResets()
    {
        _lobby.Open("c1", "Alice", true);
        _lobby.Open("c2", "Bob", true);
        _lobby.PickCharacter("c1", "dad");
        _lobby.SetReady("c2", true);

        // Everyone must have picked a character…
        _lobby.TryStart("c1").Should().BeFalse("Bob has no character yet");
        _lobby.PickCharacter("c2", "mom");

        // …only the host can start…
        _lobby.TryStart("c2").Should().BeFalse("Bob is not the host");

        // …and every non-host member must be Ready.
        _lobby.SetReady("c2", false);
        _lobby.TryStart("c1").Should().BeFalse("Bob is not ready");
        _lobby.SetReady("c2", true);
        _lobby.TryStart("c1").Should().BeTrue();

        // EndRace clears Ready flags for the next meet.
        _lobby.EndRace();
        _lobby.Members.Should().OnlyContain(m => !m.IsReady);

        // Host leaving migrates host to the next member.
        _lobby.Leave("c1");
        _lobby.State.HostConnectionId.Should().Be("c2");

        // Draining the lobby clears a stale started flag for the next visitor.
        _lobby.PickCharacter("c2", "dad");
        _lobby.TryStart("c2").Should().BeTrue();
        _lobby.Leave("c2");
        var (state, _) = _lobby.Open("c9", "Cara", true);
        state.Phase.Should().Be("waiting");
        state.HostConnectionId.Should().Be("c9");
    }
}
