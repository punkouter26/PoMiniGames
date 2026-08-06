using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Auth;
using PoMiniGames.Shared.Games;

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
    /// Spectators join the group without claiming a lane. Returns null when no meet is
    /// joinable (none started, or the last one already finished) — the client sends the
    /// player back to the lobby rather than a race that will never run.
    /// </summary>
    public Task<PoSportsJoinResult?> JoinRace(string code, bool asPlayer = false, string? displayName = null, bool isGuest = true)
    {
        if (string.IsNullOrWhiteSpace(code)) return Task.FromResult<PoSportsJoinResult?>(null);
        var race = _registry.TryGetOrCreate(code);
        if (race is null) return Task.FromResult<PoSportsJoinResult?>(null);
        // Group on the race's own code, never the caller's spelling, so a differently-cased
        // URL still lands in the group the broadcasts actually target.
        _registry.RegisterConnection(race.GameCode, Context.ConnectionId);

        var lane = -1;
        if (asPlayer)
        {
            var identity = RequestIdentity.Resolve(Context.User);
            var name = string.IsNullOrWhiteSpace(displayName) ? "Player" : displayName!;
            var owned = race.RegisterOwner(Context.ConnectionId, name, identity.UserId, isGuest);
            if (owned is null)
            {
                _log.LogWarning("PoSports: no lane for {Name} in race {Code}", name, race.GameCode);
            }
            lane = owned ?? -1;
        }

        return AddToGroupAndSnapshotAsync();

        async Task<PoSportsJoinResult?> AddToGroupAndSnapshotAsync()
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, PoSportsRaceRegistry.RaceGroup(race.GameCode));
            return new PoSportsJoinResult(lane, race.Snapshot());
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
