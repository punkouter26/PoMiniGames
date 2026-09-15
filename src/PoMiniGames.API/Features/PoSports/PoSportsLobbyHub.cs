using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoSports;

/// <summary>
/// The PoSports room over the shared lobby hub, plus the first-come character pick. The
/// meet itself is created by the race registry when clients call JoinRace on the race
/// hub; the start broadcast only moves everyone to the race page.
/// </summary>
public sealed class PoSportsLobbyHub : LobbyHub<PoSportsLobbyMember, PoSportsLobbyService>
{
    public PoSportsLobbyHub(PoSportsLobbyService lobby, ILogger<PoSportsLobbyHub> log)
        : base(lobby, "posports-lobby", log)
    {
    }

    protected override string StartingMessage => "Meet starting…";

    protected override (LobbyState<PoSportsLobbyMember> state, string message) OpenSeat(string displayName, bool isGuest)
    {
        // The room keeps the claim-derived id server-side so the race can bind lanes by
        // identity instead of the client-supplied name.
        var userId = RequestIdentity.Resolve(Context.User).UserId;
        return Lobby.Open(Context.ConnectionId, displayName, isGuest, userId);
    }

    protected override Task OnStartingAsync() => Task.CompletedTask;

    /// <summary>Claim a character (first-come lock). Returns false when it is taken.</summary>
    public async Task<bool> PickCharacter(string character)
    {
        var (ok, msg) = Lobby.PickCharacter(Context.ConnectionId, character);
        await BroadcastStateAsync();
        if (!string.IsNullOrEmpty(msg))
        {
            await BroadcastEventAsync(ok ? "pick" : "pick-denied", msg);
        }
        return ok;
    }
}
