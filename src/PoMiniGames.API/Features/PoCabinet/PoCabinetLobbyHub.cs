using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Auth;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// SignalR hub for the PoCabinet multiplayer lobby, at <c>/pocabinet/lobby-hub</c>. The host
/// opens a lobby (public ones show up in <see cref="ListOpen"/>), guests join by code, the host
/// picks the track and how many AI officials fill free seats, and <see cref="TryStart"/> builds
/// the grid and hands off to <see cref="PoCabinetRaceHub"/>. Every change is broadcast to the
/// lobby group as <c>LobbyState</c>.
///
/// <para>
/// Identity comes from the claims (<see cref="RequestIdentity"/>), never from the client: seats
/// are keyed by it and a signed-in player's claim name wins over whatever name they typed.
/// Hub endpoints require auth (<c>/negotiate</c> included), mapped in
/// <c>EndpointRouteExtensions</c>.
/// </para>
/// </summary>
public sealed class PoCabinetLobbyHub(PoCabinetLobbyService lobbies, PoCabinetRaceRegistry races) : Hub
{
    public async Task<PoCabinetLobbyView> Open(string displayName, string? trackId, bool isPublic, string? color)
    {
        var me = Caller(displayName);
        var code = lobbies.Open(me.Id, me.Name, me.IsGuest, trackId, isPublic, color, Context.ConnectionId);
        await Groups.AddToGroupAsync(Context.ConnectionId, PoCabinetRaceRegistry.LobbyGroup(code));
        return lobbies.View(code, me.Id)!;
    }

    public async Task<PoCabinetLobbyView?> Join(string joinCode, string displayName, string? color)
    {
        var me = Caller(displayName);
        var lobby = lobbies.Join(joinCode, me.Id, me.Name, me.IsGuest, color, Context.ConnectionId);
        if (lobby is null) return null;
        await Groups.AddToGroupAsync(Context.ConnectionId, PoCabinetRaceRegistry.LobbyGroup(lobby.Code));
        await BroadcastAsync(lobby.Code);
        return lobbies.View(lobby.Code, me.Id);
    }

    public Task<bool> ToggleReady(string joinCode) => MutateAsync(joinCode, id => lobbies.ToggleReady(joinCode, id));

    public Task<bool> SetTrack(string joinCode, string trackId) => MutateAsync(joinCode, id => lobbies.SetTrack(joinCode, id, trackId));

    public Task<bool> SetBots(string joinCode, int count) => MutateAsync(joinCode, id => lobbies.SetBots(joinCode, id, count));

    public Task<bool> SetPublic(string joinCode, bool isPublic) => MutateAsync(joinCode, id => lobbies.SetPublic(joinCode, id, isPublic));

    public async Task<bool> TryStart(string joinCode)
    {
        var me = Caller(null);
        var lobby = lobbies.Start(joinCode, me.Id);
        if (lobby is null) return false;
        races.Create(lobby.Code, lobby.TrackId, lobbies.BuildGrid(lobby.Code));
        await BroadcastAsync(lobby.Code);
        await Clients.Group(PoCabinetRaceRegistry.LobbyGroup(lobby.Code)).SendAsync("RaceStarting", lobby.Code, lobby.TrackId);
        return true;
    }

    public async Task Leave(string joinCode)
    {
        var me = Caller(null);
        lobbies.Leave(joinCode, me.Id);
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, PoCabinetRaceRegistry.LobbyGroup(joinCode));
        await BroadcastAsync(joinCode);
    }

    /// <summary>Public lobbies with a free seat, and public races that can be spectated.</summary>
    public IReadOnlyList<PoCabinetLobbySummary> ListOpen() => lobbies.ListPublic();

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        foreach (var code in lobbies.DropConnection(Context.ConnectionId))
        {
            await BroadcastAsync(code);
        }
        await base.OnDisconnectedAsync(exception);
    }

    private async Task<bool> MutateAsync(string joinCode, Func<string, bool> change)
    {
        var me = Caller(null);
        if (!change(me.Id)) return false;
        await BroadcastAsync(joinCode);
        return true;
    }

    private Task BroadcastAsync(string joinCode)
    {
        var view = lobbies.View(joinCode);
        return view is null
            ? Task.CompletedTask
            : Clients.Group(PoCabinetRaceRegistry.LobbyGroup(joinCode)).SendAsync("LobbyState", view);
    }

    private (string Id, string Name, bool IsGuest) Caller(string? requestedName)
    {
        var identity = RequestIdentity.Resolve(Context.User);
        if (string.IsNullOrEmpty(identity.UserId))
            throw new HubException("Sign in or continue as a guest to race.");
        var typed = SanitizeName(requestedName);
        var name = identity.IsAuthenticated && !string.IsNullOrWhiteSpace(identity.DisplayName)
            ? identity.DisplayName
            : typed ?? (string.IsNullOrWhiteSpace(identity.DisplayName) ? "Player" : identity.DisplayName);
        return (identity.UserId, name.Length > 24 ? name[..24] : name, identity.IsGuest);
    }

    private static string? SanitizeName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        var clean = new string(name.Where(ch => !char.IsControl(ch)).ToArray()).Trim();
        return clean.Length == 0 ? null : clean;
    }
}
