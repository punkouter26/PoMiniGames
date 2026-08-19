using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoVoxelStrike;

/// <summary>
/// Runtime hub for an active co-op run. The client connects after <see cref="PoVoxelStrikeLobbyHub.StartGame"/>
/// and calls <see cref="JoinLockstep"/> to bind its connection to the session. The
/// hub pumps a single <see cref="PoVoxelStrikeLockstepFrame"/> every <see cref="PoVoxelStrikeLockstepService.TickIntervalMs"/>
/// with every peer's input batched in order; clients apply them to their local engine
/// and emit heartbeats so the server can flag desync.
/// </summary>
public sealed class PoVoxelStrikeLockstepHub : Hub
{
    private readonly PoVoxelStrikeLobbyService _lobby;
    private readonly PoVoxelStrikeLockstepService _lockstep;
    private readonly ILogger<PoVoxelStrikeLockstepHub> _log;

    public PoVoxelStrikeLockstepHub(
        PoVoxelStrikeLobbyService lobby,
        PoVoxelStrikeLockstepService lockstep,
        ILogger<PoVoxelStrikeLockstepHub> log)
    {
        _lobby = lobby;
        _lockstep = lockstep;
        _log = log;
    }

    public override async Task OnConnectedAsync()
    {
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? ex)
    {
        var session = _lockstep.GetByConnection(Context.ConnectionId);
        if (session is not null)
        {
            await Clients.Group(PoVoxelStrikeLockstepService.GroupPrefix + "-" + session.GameCode)
                .SendAsync("playerDropped", Context.ConnectionId);
        }
        _lockstep.RemoveConnection(Context.ConnectionId);
        await base.OnDisconnectedAsync(ex);
    }

    /// <summary>Bind the connection to the run session and add to the SignalR group.</summary>
    public async Task<PoVoxelStrikeLockstepSessionInfo> JoinLockstep(string gameCode)
    {
        var session = _lockstep.GetOrCreateSession(gameCode, _lobby.Players);
        _lockstep.BindConnection(Context.ConnectionId, gameCode);
        await Groups.AddToGroupAsync(Context.ConnectionId, PoVoxelStrikeLockstepService.GroupPrefix + "-" + gameCode);
        _log.LogInformation("PoVoxelStrike lockstep: conn={Conn} joined session={Game} players={Count}",
            Context.ConnectionId, gameCode, session.Players.Count);
        return new PoVoxelStrikeLockstepSessionInfo(
            GameCode: gameCode,
            TickHz: PoVoxelStrikeLockstepService.TickHz,
            Players: session.Players,
            StartedAtMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    /// <summary>Submit a batch of inputs for the current tick. The next frame will broadcast them to all peers.</summary>
    public Task SubmitInputs(PoVoxelStrikeInputBatch batch)
    {
        batch.ConnectionId = Context.ConnectionId;
        var session = _lockstep.GetByConnection(Context.ConnectionId);
        session?.SubmitInput(batch);
        return Task.CompletedTask;
    }

    /// <summary>Heartbeat from the client. Server records the last ack tick + fingerprint for desync detection.</summary>
    public Task Heartbeat(PoVoxelStrikeClientHeartbeat heartbeat)
    {
        var session = _lockstep.GetByConnection(Context.ConnectionId);
        session?.Heartbeat(heartbeat, Context.ConnectionId);
        return Task.CompletedTask;
    }

    /// <summary>End the run and tear down the session. Only the host may call this.</summary>
    public async Task EndRun()
    {
        var session = _lockstep.GetByConnection(Context.ConnectionId);
        if (session is null) return;
        // Only the host can end the run — the host is whoever the lobby currently has as host.
        if (_lobby.HostConnectionId != Context.ConnectionId) return;
        await Clients.Group(PoVoxelStrikeLockstepService.GroupPrefix + "-" + session.GameCode)
            .SendAsync("runEnded");
        _lockstep.EndRun(session.GameCode);
        _lobby.EndRun();
    }
}

/// <summary>One-shot payload the lockstep hub returns to a freshly-joined client.</summary>
// Defined in PoMiniGames.Shared.Games so the client wrapper can type it without an
// API-project reference. See PoMiniGames.Shared.Games.PoVoxelStrikeLockstepSessionInfo.
