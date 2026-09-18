using Microsoft.AspNetCore.SignalR;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// SignalR hub for the PoCabinet multiplayer lobby. Lives at
/// <c>/pocabinet/lobby-hub</c>. Host creates a lobby, guests join by code, host
/// starts the race and the connection hands off to <see cref="PoCabinetRaceHub"/>
/// at <c>/pocabinet/race-hub</c>.
///
/// <para>
/// Hub endpoints require auth (CLAUDE.md §3) but the <c>/negotiate</c> call is
/// anonymous by SignalR's design — it returns the connection token the JS
/// client uses to attach. CSRF does not apply to SignalR's WebSocket transport
/// (per the framework's <c>AntiforgeryExtensions</c> header — see CLAUDE.md).
/// </para>
/// </summary>
public sealed class PoCabinetLobbyHub : Hub
{
    private readonly PoCabinetLobbyService _lobbies;

    public PoCabinetLobbyHub(PoCabinetLobbyService lobbies) => _lobbies = lobbies;

    public string Open(string displayName, bool isGuest, string? trackId)
    {
        var code = _lobbies.Open(Context.ConnectionId, displayName, isGuest, trackId);
        Groups.AddToGroupAsync(Context.ConnectionId, $"lobby:{code}");
        return code;
    }

    public PoCabinetLobbyService.Lobby? Join(string joinCode, string displayName, bool isGuest)
    {
        var lobby = _lobbies.Join(joinCode, Context.ConnectionId, displayName, isGuest);
        if (lobby is not null)
        {
            Groups.AddToGroupAsync(Context.ConnectionId, $"lobby:{joinCode}");
            Clients.OthersInGroup($"lobby:{joinCode}").SendAsync("PlayerJoined", displayName);
        }
        return lobby;
    }

    public bool ToggleReady(string joinCode)
    {
        var ok = _lobbies.ToggleReady(joinCode, Context.ConnectionId);
        if (ok)
        {
            Clients.Group($"lobby:{joinCode}").SendAsync("LobbyState", _lobbies.GetByCode(joinCode));
        }
        return ok;
    }

    public bool TryStart(string joinCode)
    {
        var lobby = _lobbies.Start(joinCode, Context.ConnectionId);
        if (lobby is null) return false;
        Clients.Group($"lobby:{joinCode}").SendAsync("RaceStarting", lobby.TrackId, lobby.Players);
        return true;
    }

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        // Iterate open lobbies and remove this connection from each. Small lobby pool
        // means a linear scan is fine — keeps the contract simple.
        foreach (var lobby in _lobbies.GetType()
                     .GetField("_byCode", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)?
                     .GetValue(_lobbies) as System.Collections.IDictionary ?? new System.Collections.Hashtable())
        {
            if (lobby is System.Collections.DictionaryEntry de && de.Value is PoCabinetLobbyService.Lobby l)
            {
                _lobbies.Leave(l.Code, Context.ConnectionId);
            }
        }
        return Task.CompletedTask;
    }
}
