using PoMiniGames.Domain.Primitives;

namespace PoMiniGames.Shared.Games;

// ─────────────────────────────  Lobby  ──────────────────────────────
//
// Shape mirrors the PoRacer lobby so the client can lift the existing
// lobby page with minimal surgery. 1v1 only: the lobby is open while
// exactly one human is waiting, the second arrival triggers a "ready
// check" and the host's Start button launches the fight. The cap is 2 —
// any further arrivals are bounced.
//
// The lobby lives entirely in process memory (PoBrawlLobbyService) —
// there is no need to persist it: if the host restarts, players re-join.

/// <summary>
/// One connection currently waiting in the PoBrawl lobby. <see cref="ConnectionId"/>
/// is the SignalR connection id; <see cref="PrincipalId"/> is the stable auth-cookie
/// subject id (server-canonical, server-supplied — the client never authors it).
/// </summary>
public sealed record PoBrawlLobbyPlayer(
    string ConnectionId,
    string PrincipalId,
    string DisplayName,
    bool IsGuest,
    bool IsReady,
    PoBrawlFighter Fighter);

public sealed record PoBrawlLobbyState(
    IReadOnlyList<PoBrawlLobbyPlayer> Players,
    string? HostConnectionId,
    string GameCode,
    DateTimeOffset LastUpdatedUtc)
{
    /// <summary>1v1 cap — the lobby bounces the third arrival.</summary>
    public const int MaxPlayers = 2;
}

public sealed record PoBrawlLobbyEvent(
    string Kind,
    string Message,
    DateTimeOffset AtUtc);

// ─────────────────────────  Match result  ───────────────────────────
//
// POSTed by the winning client (or both, on a draw — each submits its own
// record with their own outcome). The server applies claim identity,
// dedupes by MatchId, increments the per-player Elo via PairwiseEloCalculator,
// and writes a MatchRecordEntity so /api/matches reflects the result.

/// <summary>
/// Result payload the server stores after a 1v1 PoBrawl fight ends. Either player
/// may POST one of these; the server folds it into MatchHistory + the Elo table.
/// </summary>
public sealed class PoBrawlMatchResultDto
{
    /// <summary>Stable id for the match (GUID the lobby stamped on Start). Dedupes retries.</summary>
    public string MatchId { get; set; } = "";
    /// <summary>The submitting player's principal id. Server overrides with claim identity.</summary>
    public string OwnerId { get; set; } = "";
    public string OwnerDisplayName { get; set; } = "";
    /// <summary>The opponent's principal id. Server-supplied at match-start so the Elo
    /// increment can land on the opponent's row without a second round-trip.</summary>
    public string OpponentId { get; set; } = "";
    /// <summary>The opponent's display name. Free-text — there's no server-side player roster for humans.</summary>
    public string OpponentDisplayName { get; set; } = "";
    /// <summary>Fighter the owner used.</summary>
    public PoBrawlFighter OwnerFighter { get; set; } = new("", "");
    /// <summary>Fighter the opponent used.</summary>
    public PoBrawlFighter OpponentFighter { get; set; } = new("", "");
    /// <summary>Win / Loss / Draw, from the owner's perspective.</summary>
    public PoBrawlOutcome Outcome { get; set; }
    /// <summary>Wall-clock match duration in seconds. Used for the plausibility guard.</summary>
    public double DurationSeconds { get; set; }
}

public enum PoBrawlOutcome
{
    Win = 0,
    Loss = 1,
    Draw = 2,
}
