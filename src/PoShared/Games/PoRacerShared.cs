namespace PoShared.Games;

/// <summary>
/// Server-canonical score payload. The host API overrides <see cref="PlayerDisplayName"/>
/// with the authenticated identity and dedupes by content hash.
/// </summary>
public sealed class PoRacerScoreDto
{
    public string PlayerDisplayName { get; set; } = "";
    /// <summary>Server-populated from auth cookie. Empty/zero on submit → server fills.</summary>
    public string UserId { get; set; } = "";
    public double TotalTimeSeconds { get; set; }
    public int FinalPosition { get; set; }
    public DateTimeOffset AchievedAtUtc { get; set; }
    public bool IsGuest { get; set; }
    public string GameCode { get; set; } = "";
}

// ──────────────────────────────  Lobby  ──────────────────────────────

public sealed record PoRacerLobbyPlayer(
    string ConnectionId,
    string DisplayName,
    bool IsGuest,
    bool IsReady);

public sealed record PoRacerLobbyState(
    IReadOnlyList<PoRacerLobbyPlayer> Players,
    string? HostConnectionId,
    string GameCode,
    DateTimeOffset LastUpdatedUtc);

/// <summary>Transient toast-style event surfaced by the lobby (join/leave/host-migrated).</summary>
public sealed record PoRacerLobbyEvent(
    string Kind,
    string Message,
    DateTimeOffset AtUtc);

// ──────────────────────────────  Race  ──────────────────────────────

/// <summary>
/// Server-authoritative snapshot of every car in the race. Broadcast hub → client at ~20 Hz.
/// </summary>
public sealed class PoRacerCarState
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string Color { get; set; } = "#ffffff";
    public string ColorDark { get; set; } = "#222222";
    public double X { get; set; }
    public double Y { get; set; }
    public double Heading { get; set; }
    public double Speed { get; set; }
    public int Lap { get; set; }
    public double FinishTime { get; set; } = -1;
    public bool IsPlayer { get; set; }
    public bool Finished { get; set; }
    public int Position { get; set; }
    public double SkidIntensity { get; set; }
    public double BoostGlow { get; set; }
    public double Damage { get; set; }
}

/// <summary>
/// Wire frame broadcast from hub → clients at ~20 Hz.
/// </summary>
public sealed class PoRacerRaceSnapshot
{
    public string GameCode { get; set; } = "";
    public double ServerTimeMs { get; set; }
    public IReadOnlyList<PoRacerCarState> Cars { get; set; } = new List<PoRacerCarState>();
    public double ElapsedRaceTime { get; set; }
    public int CountdownMs { get; set; }
    public bool Started { get; set; }
    public bool Finished { get; set; }
    public PoRacerStaticWorld? Static { get; set; }
}

/// <summary>Track geometry — sent once per race on join so the client can render statically.</summary>
public sealed class PoRacerStaticWorld
{
    public IReadOnlyList<double> CenterXY { get; set; } = new List<double>();
    public IReadOnlyList<double> WallsXY { get; set; } = new List<double>();
    public double TrackWidth { get; set; }
    public double MinX { get; set; }
    public double MinY { get; set; }
    public double MaxX { get; set; }
    public double MaxY { get; set; }
    public int TotalLaps { get; set; } = 3;
}

/// <summary>Client → hub input packet. Matches the keyboard + touch shape used by the JS thin client.</summary>
public sealed class PoRacerInput
{
    public bool Up { get; set; }
    public bool Down { get; set; }
    public bool Left { get; set; }
    public bool Right { get; set; }
    public bool Space { get; set; }
    public long ClientTs { get; set; }
}

public sealed record PoRacerFinalResult(
    string GameCode,
    IReadOnlyList<PoRacerFinalEntry> Standings,
    DateTimeOffset FinishedAtUtc);

public sealed record PoRacerFinalEntry(
    int Position,
    string Name,
    string UserId,
    bool IsGuest,
    double TotalTimeSeconds,
    bool Finished);
