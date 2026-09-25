using System.Text.Json.Serialization;
using PoMiniGames.Shared.Games.PoJevArena;

namespace PoMiniGamesClient.Games.PoJevArena;

// Payloads the engine (js/pojevarena/index.js) sends back through [JSInvokable] callbacks, as JSON
// strings deserialised with the source-generated context below (trim-safe; no reflection JSON).

/// <summary>One Jev answer as the Black Box recorded it (see blackbox.js recordDecision).</summary>
public sealed record ArenaDecisionView(
    int Frame,
    int Unit,
    bool Ok,
    string? Failure,
    string? Action,
    double ActionConfidence,
    Dictionary<string, double>? ActionProbabilities,
    string? Focus,
    double FocusConfidence,
    Dictionary<string, double>? FocusProbabilities,
    double Panic,
    int LatencyMs);

/// <summary>The selected unit on one side, and the Jev distribution governing it at this frame.</summary>
public sealed record ArenaInspectorView(
    string Unit,
    int Index,
    string Team,
    string Name,
    string CreatureId,
    int Hp,
    int MaxHp,
    bool Alive,
    string Action,
    string? Target,
    double StaleSeconds,
    int Frame,
    string Mode,
    ArenaDecisionView? Decision);

public sealed record ArenaHudView(
    double Time,
    int BlueAlive,
    int RedAlive,
    int Calls,
    long? Remaining,
    string[] Notices,
    string? Stopped);

public sealed record ArenaMatchEndView(
    string Winner,
    string Reason,
    double DurationSeconds,
    int BlueAlive,
    int RedAlive,
    int Calls,
    int Decisions,
    int Frames);

public sealed record ArenaBlackBoxView(int Frame, int Frames, double Seconds, bool Playing, double Speed, int Decisions);

/// <summary>What the page remembers between visits: the last two rosters (library ids or preset ids).</summary>
public sealed record ArenaSavedRosters(string?[] Blue, string?[] Red);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true)]
[JsonSerializable(typeof(ArenaInspectorView))]
[JsonSerializable(typeof(ArenaHudView))]
[JsonSerializable(typeof(ArenaMatchEndView))]
[JsonSerializable(typeof(ArenaBlackBoxView))]
[JsonSerializable(typeof(ArenaSavedRosters))]
internal sealed partial class ArenaUiJsonContext : JsonSerializerContext
{
}
