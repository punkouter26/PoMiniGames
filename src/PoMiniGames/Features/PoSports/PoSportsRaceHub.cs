using Microsoft.AspNetCore.SignalR;
using PoShared.Games;

namespace PoMiniGames.Features.PoSports;

/// <summary>
/// Server-authoritative meet hub. Each connection joins a per-race group
/// (<c>posports-race-{CODE}</c>) and receives <see cref="PoSportsSnapshot"/>s at
/// ~15 Hz plus a final snapshot on <c>raceFinished</c>. Clients send their sequence
/// keys as layout ordinals (0-3) and jumps; the sim applies the sequence rules.
/// Broadcast wiring lives in <see cref="PoSportsRaceRegistry"/> (singleton), not
/// here — hubs are transient.
/// </summary>
public sealed class PoSportsRaceHub : Hub
{
    private readonly PoSportsRaceRegistry _registry;
    private readonly ILogger<PoSportsRaceHub> _log;

    public PoSportsRaceHub(PoSportsRaceRegistry registry, ILogger<PoSportsRaceHub> log)
    {
        _registry = registry;
        _log = log;
    }

    public override async Task OnDisconnectedAsync(Exception? ex)
    {
        var code = _registry.CodeFor(Context.ConnectionId);
        _registry.RemoveConnection(Context.ConnectionId);
        if (code is not null)
        {
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, PoSportsRaceRegistry.RaceGroup(code));
        }
        await base.OnDisconnectedAsync(ex);
    }

    /// <summary>
    /// Join a meet. Idempotent — a reconnecting player rebinds their lane (sequence
    /// progress resets; banked speed survives) and pulls the latest snapshot.
    /// Spectators join the group without claiming a lane.
    /// </summary>
    public Task<PoSportsSnapshot?> JoinRace(string code, bool asPlayer = false, string? displayName = null, bool isGuest = true)
    {
        if (string.IsNullOrWhiteSpace(code)) return Task.FromResult<PoSportsSnapshot?>(null);
        var race = _registry.GetOrCreate(code);
        _registry.RegisterConnection(code, Context.ConnectionId);

        if (asPlayer)
        {
            var user = Context.User;
            var userId = user?.FindFirst("sub")?.Value
                         ?? user?.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
                         ?? user?.FindFirst("oid")?.Value
                         ?? "";
            var name = string.IsNullOrWhiteSpace(displayName) ? "Player" : displayName!;
            var lane = race.RegisterOwner(Context.ConnectionId, name, userId, isGuest);
            if (lane is null)
            {
                _log.LogWarning("PoSports: no lane for {Name} in race {Code}", name, code);
            }
        }

        return AddToGroupAndSnapshotAsync();

        async Task<PoSportsSnapshot?> AddToGroupAndSnapshotAsync()
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, PoSportsRaceRegistry.RaceGroup(code));
            return race.Snapshot();
        }
    }

    /// <summary>One sequence key: the ordinal (0-3) of the pressed key in the player's layout.</summary>
    public Task SendSequenceKey(string code, int step)
    {
        _registry.GetByCode(code)?.SendSequenceKey(Context.ConnectionId, step);
        return Task.CompletedTask;
    }

    public Task SendJump(string code)
    {
        _registry.GetByCode(code)?.SendJump(Context.ConnectionId);
        return Task.CompletedTask;
    }
}
