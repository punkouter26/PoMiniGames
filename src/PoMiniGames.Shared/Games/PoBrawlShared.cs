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
// The lobby state and event records live in LobbyShared.cs (LobbyState<PoBrawlLobbyPlayer>,
// LobbyEvent) — one wire shape for every ready/start lobby. The 1v1 cap
// is PoBrawlLobbyService.Cap and arrives on the wire as LobbyState.MaxPlayers.
public sealed record PoBrawlLobbyPlayer(
    string ConnectionId,
    string PrincipalId,
    string DisplayName,
    bool IsGuest,
    bool IsReady,
    PoBrawlFighter Fighter) : ILobbyPlayer;

/// <summary>
/// A finished 1v1 fight, reported by either corner to POST /api/pobrawl/matches. Only the id:
/// outcome, opponent and duration are read from the server's own copy of the match.
/// </summary>
public sealed class PoBrawlMatchResultDto
{
    /// <summary>Stable id for the match (GUID the lobby stamped on Start). Dedupes retries.</summary>
    public string MatchId { get; set; } = "";
}

public enum PoBrawlOutcome
{
    Win = 0,
    Loss = 1,
    Draw = 2,
}

/// <summary>
/// A player's 1P ladder progress (GET/PUT /api/pobrawl/progress), so a run follows them across
/// devices. The client keeps the same numbers in localStorage and the newer copy wins the rung.
/// </summary>
public sealed class PoBrawlProgressDto
{
    /// <summary>0-based rung: the president the next fight is against.</summary>
    public int Rung { get; set; }
    /// <summary>Fastest KO ever, seconds; 0 for none.</summary>
    public double BestKoSeconds { get; set; }
    /// <summary>Full ladder clears, all time.</summary>
    public int Clears { get; set; }
    /// <summary>When the rung was written, Unix ms — the tiebreak between two devices.</summary>
    public long UpdatedAtUnixMs { get; set; }
}
