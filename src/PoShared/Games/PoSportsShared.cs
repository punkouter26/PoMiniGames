namespace PoShared.Games;

// ──────────────────────────────  Lobby  ──────────────────────────────

public sealed record PoSportsLobbyMember(
    string ConnectionId,
    string DisplayName,
    bool IsGuest,
    /// <summary>Character key (mom|kim|matt|nick|tong), "" until picked. First-come lock.</summary>
    string Character,
    bool IsReady);

public sealed record PoSportsLobbyState(
    IReadOnlyList<PoSportsLobbyMember> Members,
    string? HostConnectionId,
    string GameCode,
    /// <summary>waiting | starting</summary>
    string Phase,
    DateTimeOffset LastUpdatedUtc);

/// <summary>Transient toast-style event surfaced by the lobby (join/leave/pick/ready).</summary>
public sealed record PoSportsLobbyEvent(
    string Kind,
    string Message,
    DateTimeOffset AtUtc);

// ──────────────────────────────  Race  ──────────────────────────────

/// <summary>One lane's state inside a snapshot. Positions in meters from the start line.</summary>
public sealed record PoSportsLaneState(
    int Lane,
    string Name,
    string Character,
    bool IsAi,
    double Position,
    double Speed,
    /// <summary>Index of the next expected sequence key, 0-3 — drives the HUD progress dots.</summary>
    int SeqProgress,
    bool Airborne,
    bool Stumbling,
    /// <summary>Elapsed time on the current leg including stumble penalties, seconds.</summary>
    double LegTime,
    bool Finished,
    /// <summary>Sprint leg time once that leg is done, else -1.</summary>
    double SprintSeconds,
    /// <summary>Hurdles leg time once the meet is done, else -1.</summary>
    double HurdlesSeconds,
    /// <summary>Final placing 1-4 once the meet is done, else 0.</summary>
    int Placing);

/// <summary>
/// Server-authoritative snapshot of the whole meet. Broadcast hub → client at ~15 Hz;
/// the client renders remote lanes by interpolating between the last two snapshots.
/// </summary>
public sealed record PoSportsSnapshot(
    /// <summary>countdown | sprint | interstitial | hurdles | podium</summary>
    string Phase,
    /// <summary>Seconds remaining in countdown/interstitial, or elapsed leg clock.</summary>
    double Clock,
    IReadOnlyList<PoSportsLaneState> Lanes);
