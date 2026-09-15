using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoSports;

/// <summary>
/// The PoSports room: the shared ready/start lobby plus a first-come character lock,
/// and a claim-derived identity per seat that is deliberately NOT broadcast — the race
/// binds lanes by it (see <see cref="Seats"/>), and a stable user id is not ours to share.
/// </summary>
public sealed class PoSportsLobbyService : LobbyRoom<PoSportsLobbyMember>
{
    public const string GlobalCode = "LOBBY";

    /// <summary>Lanes on the track — and therefore the human cap per meet.</summary>
    public const int MaxPlayersPerMeet = 4;

    private readonly Dictionary<string, string> _identities = new(StringComparer.Ordinal);

    public PoSportsLobbyService() : base(GlobalCode, MaxPlayersPerMeet, "Meet already in progress")
    {
    }

    public (LobbyState<PoSportsLobbyMember> state, string message) Open(
        string connectionId, string displayName, bool isGuest, string userId = "")
    {
        var result = OpenCore(connectionId, displayName, isGuest,
            (name, _, _) => new PoSportsLobbyMember(connectionId, name, isGuest, "", false));
        if (result.state.Players.Any(m => m.ConnectionId == connectionId))
        {
            WithLock<object?>(_ => { _identities[connectionId] = userId ?? ""; return null; });
        }
        return result;
    }

    /// <summary>
    /// Lane seeds for the race: each member's already-sanitized name and character plus the
    /// identity we never broadcast, so a player whose name was truncated (or who reconnects)
    /// still finds their own lane.
    /// </summary>
    public IReadOnlyList<PoSportsRaceSeat> Seats =>
        WithLock(players => players.Values
            .OrderBy(m => m.ConnectionId, StringComparer.Ordinal)
            .Select(m => new PoSportsRaceSeat(
                m.DisplayName,
                m.Character,
                _identities.TryGetValue(m.ConnectionId, out var uid) ? uid : "",
                m.IsGuest))
            .ToList());

    /// <summary>
    /// Claim a character (first-come lock). Fails when the key is unknown or another member
    /// already holds it; re-picking your own character is a no-op success.
    /// </summary>
    public (bool ok, string message) PickCharacter(string connectionId, string character) =>
        WithLock(players =>
        {
            if (!players.TryGetValue(connectionId, out var member)) return (false, "Not in lobby");
            if (!PoSportsConstants.Characters.Contains(character)) return (false, "Unknown character");
            var holder = players.Values.FirstOrDefault(m => m.Character == character);
            if (holder is not null && holder.ConnectionId != connectionId)
            {
                return (false, $"{character} is taken");
            }
            players[connectionId] = member with { Character = character };
            return (true, $"{member.DisplayName} picked {character}");
        });

    protected override PoSportsLobbyMember WithReady(PoSportsLobbyMember player, bool ready) =>
        player with { IsReady = ready };

    /// <summary>Everyone must also have picked — the meet cannot seed a lane without a character.</summary>
    protected override bool CanStart(IReadOnlyList<PoSportsLobbyMember> players, string hostConnectionId) =>
        base.CanStart(players, hostConnectionId) && players.All(m => !string.IsNullOrEmpty(m.Character));

    protected override void OnLeft(string connectionId) => _identities.Remove(connectionId);
}
