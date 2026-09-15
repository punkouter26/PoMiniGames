using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Auth;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.ConnectFive;

/// <summary>
/// The single hub for online Connect Five: quick-match queue, moves, rematch and
/// reconnect. State lives in <see cref="ConnectFiveMatchService"/>; this class only
/// resolves identity, relays rejected moves as <see cref="HubException"/>s the
/// client can toast, and fans results out to the per-match group.
/// </summary>
/// <remarks>
/// Client events: <c>matchStarted</c> (<see cref="ConnectFiveMatchStart"/>, sent to
/// each seat separately because it carries that seat's private token and colour) and
/// <c>state</c> (<see cref="ConnectFiveMatchState"/>, sent to the match group).
/// </remarks>
public sealed class ConnectFiveHub : Hub
{
    private readonly ConnectFiveMatchService _matches;
    private readonly ILogger<ConnectFiveHub> _log;

    public ConnectFiveHub(ConnectFiveMatchService matches, ILogger<ConnectFiveHub> log)
    {
        _matches = matches;
        _log = log;
    }

    public override async Task OnDisconnectedAsync(Exception? ex)
    {
        var state = _matches.Disconnected(Context.ConnectionId);
        if (state is not null)
        {
            await Clients.Group(ConnectFiveMatchService.GroupFor(state.MatchId)).SendAsync("state", state);
        }
        await base.OnDisconnectedAsync(ex);
    }

    /// <summary>
    /// Join the quick-match queue. Identity is server-canonical from the auth cookie;
    /// <paramref name="displayName"/> is only the fallback for a guest with no name claim.
    /// </summary>
    public async Task<ConnectFiveQueueStatus> FindMatch(string displayName, bool isGuest)
    {
        var identity = RequestIdentity.Resolve(Context.User);
        var name = !string.IsNullOrWhiteSpace(identity.DisplayName) ? identity.DisplayName : displayName;
        var pairing = _matches.Enqueue(Context.ConnectionId, identity.UserId, name, identity.IsGuest || isGuest);
        if (pairing is null)
        {
            return new ConnectFiveQueueStatus(Matched: false, Waiting: _matches.WaitingCount);
        }

        await AnnounceStartAsync(pairing);
        return new ConnectFiveQueueStatus(Matched: true, Waiting: 0);
    }

    public Task CancelSearch()
    {
        _matches.Dequeue(Context.ConnectionId);
        return Task.CompletedTask;
    }

    /// <summary>Drop a disc. A rejected move surfaces as a <see cref="HubException"/> with the reason.</summary>
    public async Task<ConnectFiveMatchState> Drop(int col)
    {
        ConnectFiveMatchState state;
        try
        {
            state = _matches.Drop(Context.ConnectionId, col);
        }
        catch (InvalidOperationException ex)
        {
            throw new HubException(ex.Message);
        }
        await Clients.Group(ConnectFiveMatchService.GroupFor(state.MatchId)).SendAsync("state", state);
        return state;
    }

    public async Task RequestRematch()
    {
        (ConnectFiveMatchState state, ConnectFiveMatchService.Pairing? rematch) result;
        try
        {
            result = _matches.RequestRematch(Context.ConnectionId);
        }
        catch (InvalidOperationException ex)
        {
            throw new HubException(ex.Message);
        }

        if (result.rematch is { } pairing)
        {
            await AnnounceStartAsync(pairing);
            return;
        }
        await Clients.Group(ConnectFiveMatchService.GroupFor(result.state.MatchId)).SendAsync("state", result.state);
    }

    /// <summary>
    /// Re-bind this connection to the seat behind <paramref name="seatToken"/> after a
    /// reconnect. Null means the seat is gone and the client should queue again.
    /// </summary>
    public async Task<ConnectFiveRejoinResult?> Rejoin(string seatToken)
    {
        var result = _matches.Rejoin(Context.ConnectionId, seatToken);
        if (result is null) return null;
        await Groups.AddToGroupAsync(Context.ConnectionId, ConnectFiveMatchService.GroupFor(result.State.MatchId));
        await Clients.Group(ConnectFiveMatchService.GroupFor(result.State.MatchId)).SendAsync("state", result.State);
        return result;
    }

    public async Task Leave()
    {
        var state = _matches.Leave(Context.ConnectionId);
        if (state is null) return;
        var group = ConnectFiveMatchService.GroupFor(state.MatchId);
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, group);
        await Clients.Group(group).SendAsync("state", state);
    }

    /// <summary>
    /// Announce a (re)start: each seat gets its own private start record, then the
    /// shared board goes to the group. Group membership is (re)asserted here because
    /// the first pairing is the first time either connection has a match to belong to.
    /// </summary>
    private async Task AnnounceStartAsync(ConnectFiveMatchService.Pairing pairing)
    {
        var group = ConnectFiveMatchService.GroupFor(pairing.MatchId);
        foreach (var (connectionId, start) in pairing.Connections)
        {
            await Groups.AddToGroupAsync(connectionId, group);
            await Clients.Client(connectionId).SendAsync("matchStarted", start);
        }
        await Clients.Group(group).SendAsync("state", pairing.State);
        _log.LogInformation("ConnectFive: match {MatchId} game {Game} started", pairing.MatchId, pairing.State.GameNumber);
    }
}
