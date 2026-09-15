using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;
using PoBrawlFighter = PoMiniGames.Domain.Primitives.PoBrawlFighter;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// The PoBrawl 1v1 room over the shared lobby hub, plus a fighter pick. A player joins as
/// the 1P avatar (Bob) and changes fighter through <see cref="PickFighter"/> — the same
/// shape as PoSports' character pick, instead of the earlier re-Join-with-a-fighter call.
/// On start the match service is created NOW with the captured roster.
/// </summary>
public sealed class PoBrawlLobbyHub : LobbyHub<PoBrawlLobbyPlayer, PoBrawlLobbyService>
{
    private readonly PoBrawlMatchRegistry _matches;

    public PoBrawlLobbyHub(PoBrawlLobbyService lobby, PoBrawlMatchRegistry matches, ILogger<PoBrawlLobbyHub> log)
        : base(lobby, "pobrawl-lobby", log)
    {
        _matches = matches;
    }

    protected override string StartingMessage => "Match starting…";

    /// <summary>
    /// Server-canonical identity from the auth cookie claims; the supplied display name is
    /// only a fallback for a genuinely anonymous guest with nothing to claim.
    /// </summary>
    protected override (LobbyState<PoBrawlLobbyPlayer> state, string message) OpenSeat(string displayName, bool isGuest)
    {
        var identity = RequestIdentity.Resolve(Context.User);
        var name = !string.IsNullOrWhiteSpace(identity.DisplayName) ? identity.DisplayName : displayName;
        return Lobby.Open(Context.ConnectionId, identity.UserId, name, identity.IsGuest || isGuest, PoBrawlRoster.Bob);
    }

    protected override async Task OnStartingAsync()
    {
        // Capture the player list NOW — the match service owns the roster from Start time,
        // so a WebSocket timeout between lobby and match can't silently drop a fighter.
        await _matches.GetOrCreateAsync(PoBrawlLobbyService.GlobalCode, Lobby.Players.ToList());
    }

    /// <summary>Pick a fighter: any rateable president, or Bob (the 1P/2P avatar).</summary>
    public async Task PickFighter(string fighterId)
    {
        PoBrawlFighter fighter;
        var canonicalId = PoBrawlRoster.Canonicalize(fighterId);
        if (canonicalId is not null)
        {
            fighter = new PoBrawlFighter(canonicalId, PoBrawlRoster.DisplayName(canonicalId));
        }
        else if (string.Equals(fighterId, PoBrawlRoster.Bob.Id, StringComparison.OrdinalIgnoreCase))
        {
            fighter = PoBrawlRoster.Bob;
        }
        else
        {
            throw new HubException($"'{fighterId}' is not a PoBrawl fighter.");
        }

        var (ok, msg) = Lobby.PickFighter(Context.ConnectionId, fighter);
        await BroadcastStateAsync();
        if (ok) await BroadcastEventAsync("pick", msg);
    }
}
