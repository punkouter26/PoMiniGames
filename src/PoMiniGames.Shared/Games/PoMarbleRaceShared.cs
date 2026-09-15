namespace PoMiniGames.Shared.Games;

// Contracts for the /pomarblerace/hub SignalR surface: online Marble Race.
//
// The race is HOST-AUTHORITATIVE. cannon-es steps with a variable frame dt and its float
// math is not guaranteed identical across two browsers, so a lockstep of the 101-marble
// physics would drift within seconds. Instead the host browser runs the only simulation
// and streams marble positions at ~15 Hz; the guest browser builds the same track from
// the same seed, renders the streamed positions, and sends only its steering. The
// server relays and pairs — it never sees a marble.

public enum MarbleRaceRole
{
    Host,
    Guest,
}

public sealed record MarbleRaceSeat(string DisplayName, bool IsGuest, MarbleRaceRole Role, bool Connected);

/// <summary>
/// Sent to each seat when a pair forms. The seed and map are what make both browsers build
/// the same course; <see cref="GuestMarbleIndex"/> is the pack slot the guest steers (the host
/// always drives marble 0, the red one).
/// </summary>
public sealed record MarbleRaceStart(
    string RaceId,
    MarbleRaceRole YourRole,
    int Seed,
    int MapId,
    int GuestMarbleIndex,
    MarbleRaceSeat Host,
    MarbleRaceSeat Guest);

/// <summary>
/// One streamed snapshot from the host. <see cref="Positions"/> is 101 × (x, y, z) little-endian
/// float32; <see cref="Flags"/> is one byte per marble: 0 live, 1 finished, 2 eliminated. The
/// guest-marble HUD numbers ride along so the guest page can show place and gap without a
/// second sim.
/// </summary>
public sealed class MarbleRaceFrame
{
    public int Tick { get; set; }
    public double Clock { get; set; }
    public string Phase { get; set; } = "racing";
    public byte[] Positions { get; set; } = [];
    public byte[] Flags { get; set; } = [];
    public int GuestPlace { get; set; }
    public int Field { get; set; }
    public double GuestProgress { get; set; }
    public double LeaderProgress { get; set; }
    public double GuestGap { get; set; }
    public double GuestSpeed { get; set; }
    public double GuestLateral { get; set; }
}

/// <summary>Host → guest phase change. <see cref="Seed"/> is the seed of the NEXT track on <c>pick</c>.</summary>
public sealed record MarbleRacePhase(string Phase, int Seed);

public sealed record MarbleRacePodium(int[] Indices, double[] Times, double[] Gaps);

/// <summary>Host → guest final standings for the two humans. Place is -1 for a marble that fell off.</summary>
public sealed record MarbleRaceResult(bool HostWon, int HostPlace, bool GuestWon, int GuestPlace);

public sealed record MarbleRaceQueueStatus(bool Matched, int Waiting);
