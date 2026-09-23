using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Auth;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// Match hub for live PoBrawl 1v1. Each connection joins a per-match group and
/// streams <see cref="PoBrawlMatchInput"/>s to the server; the server broadcasts
/// <see cref="PoBrawlMatchState"/>s from the pump and a single
/// <see cref="PoBrawlMatchResult"/> on finish.
/// </summary>
public sealed class PoBrawlMatchHub : Hub
{
    private readonly PoBrawlMatchRegistry _registry;
    private readonly ILogger<PoBrawlMatchHub> _log;

    public PoBrawlMatchHub(PoBrawlMatchRegistry registry, ILogger<PoBrawlMatchHub> log)
    {
        _registry = registry;
        _log = log;
    }

    public override async Task OnDisconnectedAsync(Exception? ex)
    {
        var matchId = _registry.MatchIdFor(Context.ConnectionId);
        if (matchId is not null)
        {
            _registry.UnregisterConnection(Context.ConnectionId);
            // No group removal needed — the pump clears the match when finished
            // and the group dies with the connection. Mid-match disconnect leaves
            // the other player to fight a ghost; the 60s timer will end the match
            // and the result broadcast still fires to whoever is left.
        }
        await base.OnDisconnectedAsync(ex);
    }

    /// <summary>
    /// Join a match by code. The lobby has already pinned both players to their
    /// sides at StartGame time, so all this hub does is (a) make sure the match
    /// exists, (b) add the connection to the per-match broadcast group, and
    /// (c) return the snapshot the client uses to render the fighter portraits.
    /// </summary>
    public async Task<PoBrawlMatchSnapshot?> JoinMatch(string code)
    {
        _log.LogInformation("PoBrawl match-hub JoinMatch conn={Conn} code={Code}", Context.ConnectionId, code);
        if (string.IsNullOrWhiteSpace(code)) return null;
        // Calling GetOrCreateAsync with an empty roster is a no-op if the lobby
        // already created the match — the registry returns the existing match.
        var match = await _registry.GetOrCreateAsync(code, Array.Empty<PoBrawlLobbyPlayer>());
        // No match running (it ended, or nobody started one): nothing to join.
        if (match is null) return null;
        // The lobby and match hubs allocate separate connection ids, so we
        // pin THIS connection to a side by re-resolving its identity through
        // the roster rather than trusting the lobby's connection id.
        var identity = RequestIdentity.Resolve(Context.User);
        match.RegisterConnectionByPrincipal(identity.UserId, Context.ConnectionId);
        _registry.RegisterConnection(match.MatchId, Context.ConnectionId);
        await Groups.AddToGroupAsync(Context.ConnectionId, MatchGroup(match.MatchId));
        var side = match.SideFor(Context.ConnectionId);
        return new PoBrawlMatchSnapshot
        {
            MatchId = match.MatchId,
            Player1 = new PoBrawlMatchPlayerInfo(match.Player1.DisplayName, match.Player1.Fighter.Id),
            Player2 = new PoBrawlMatchPlayerInfo(match.Player2.DisplayName, match.Player2.Fighter.Id),
            LocalSide = side,
        };
    }

    public async Task SubmitInput(PoBrawlMatchInput input)
    {
        _log.LogInformation("PoBrawl match-hub SubmitInput conn={Conn} action={Action} seq={Seq}", Context.ConnectionId, input.Action, input.Sequence);
        var matchId = _registry.MatchIdFor(Context.ConnectionId);
        if (matchId is null) return;
        var match = _registry.GetByMatchId(matchId);
        if (match is null) return;
        match.SubmitInput(Context.ConnectionId, input);
        await Task.CompletedTask;
    }

    /// <summary>
    /// Explicit leave (client-initiated, not disconnect). The server forgets the
    /// connection→match binding so the pump's broadcast no longer targets it; the
    /// match keeps running until the timer or a KO ends it.
    /// </summary>
    public Task LeaveMatch()
    {
        _registry.UnregisterConnection(Context.ConnectionId);
        return Task.CompletedTask;
    }

    private static string MatchGroup(string matchId) => $"pobrawl-match-{matchId}";
}
