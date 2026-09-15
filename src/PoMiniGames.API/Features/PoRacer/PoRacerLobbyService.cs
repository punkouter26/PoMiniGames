using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoRacer;

/// <summary>
/// The PoRacer room: the plain ready/start lobby with nothing to pick. Eight seats — one
/// per car on the grid. The race sim calls <see cref="LobbyRoom{TPlayer}.End"/> when the
/// last car finishes so a new host can claim the room.
/// </summary>
public sealed class PoRacerLobbyService : LobbyRoom<PoRacerLobbyPlayer>
{
    public const string GlobalCode = "LOBBY";
    public const int Cap = 8;

    public PoRacerLobbyService() : base(GlobalCode, Cap, "Race already in progress")
    {
    }

    public (LobbyState<PoRacerLobbyPlayer> state, string message) Open(string connectionId, string displayName, bool isGuest) =>
        OpenCore(connectionId, displayName, isGuest,
            (name, _, _) => new PoRacerLobbyPlayer(connectionId, name, isGuest, false));

    protected override PoRacerLobbyPlayer WithReady(PoRacerLobbyPlayer player, bool ready) =>
        player with { IsReady = ready };
}
