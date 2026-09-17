namespace PoMiniGames.Shared.Games;

/// <summary>
/// Server-canonical score payload. The host API overrides <see cref="PlayerDisplayName"/>
/// with the authenticated identity and dedupes by content hash.
/// </summary>
public sealed class PoRacerScoreDto
{
    public string PlayerDisplayName { get; set; } = "";
    /// <summary>Server-populated from auth cookie. Empty/zero on submit → server fills.</summary>
    public string UserId { get; set; } = "";
    public string TrackId { get; set; } = "circuit";
    // Keep the existing JSON field so queued scores and older clients remain readable.
    [System.Text.Json.Serialization.JsonPropertyName("totalTimeSeconds")]
    public double BestLapSeconds { get; set; }
    public int FinalPosition { get; set; }
    public DateTimeOffset AchievedAtUtc { get; set; }
    public bool IsGuest { get; set; }
    public string GameCode { get; set; } = "";
}

// ──────────────────────────────  Enums & Customization  ──────────────────────────────

public enum SurfaceKind
{
    Asphalt = 0,
    Sand = 1,
    Curbs = 2,
    BoostPad = 3
}

public sealed record PoRacerCarCustomization(string ColorHex, string LiveryPattern)
{
    public static readonly PoRacerCarCustomization Default = new("#00f0ff", "stripe");
}

public sealed class PoRacerBoostPadWire
{
    public double X { get; set; }
    public double Y { get; set; }
    public double Radius { get; set; } = 40.0;
    public double DirectionAngle { get; set; }
}

public sealed class PoRacerSurfaceZoneWire
{
    public string Name { get; set; } = "";
    public string SurfaceType { get; set; } = "asphalt";
    public double X { get; set; }
    public double Y { get; set; }
    public double Radius { get; set; }
}

// ──────────────────────────────  Lobby  ──────────────────────────────

// The lobby state and event records live in LobbyShared.cs (LobbyState<PoRacerLobbyPlayer>,
// LobbyEvent) since 2026-09-14 — one wire shape for every ready/start lobby.
public sealed record PoRacerLobbyPlayer(
    string ConnectionId,
    string DisplayName,
    bool IsGuest,
    bool IsReady,
    [property: System.Text.Json.Serialization.JsonIgnore] string UserId = "") : ILobbyPlayer;

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
    /// <summary>Fastest single lap so far, in seconds. -1 until the first lap completes.</summary>
    public double BestLapSeconds { get; set; } = -1;
    public bool IsPlayer { get; set; }
    public bool Finished { get; set; }
    public int Position { get; set; }
    public double SkidIntensity { get; set; }
    public double BoostGlow { get; set; }
    public double BoostTimer { get; set; }
    public string Surface { get; set; } = "asphalt";
    public string LiveryStyle { get; set; } = "default";
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
    public int? LocalCarId { get; set; }
    public PoRacerFinalResult? Result { get; set; }
    public bool Started { get; set; }
    public bool Finished { get; set; }
    public PoRacerStaticWorld? Static { get; set; }
}

/// <summary>Track geometry — sent once per race on join so the client can render statically.</summary>
public sealed class PoRacerStaticWorld
{
    public string TrackId { get; set; } = "circuit";
    public string TrackName { get; set; } = "Grand Prix Circuit";
    public string Theme { get; set; } = "circuit";
    public IReadOnlyList<double> CenterXY { get; set; } = new List<double>();
    public IReadOnlyList<double> WallsXY { get; set; } = new List<double>();
    public IReadOnlyList<PoRacerBoostPadWire> BoostPads { get; set; } = new List<PoRacerBoostPadWire>();
    public IReadOnlyList<PoRacerSurfaceZoneWire> SurfaceZones { get; set; } = new List<PoRacerSurfaceZoneWire>();
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
}

public sealed record PoRacerFinalResult(
    string GameCode,
    IReadOnlyList<PoRacerFinalEntry> Standings,
    DateTimeOffset FinishedAtUtc);

public sealed record PoRacerFinalEntry(
    int Position,
    string Name,
    int CarId,
    bool IsGuest,
    double TotalTimeSeconds,
    bool Finished,
    double BestLapSeconds = -1);
