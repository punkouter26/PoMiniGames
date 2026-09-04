using System.Text.Json.Serialization;

namespace PoMiniGamesClient.Games.PoEcosystem.Models;

// Flat records only — these cross the JS interop boundary through the source-generated
// serializer below, so the WASM trim analyzer sees no reflection (§1.7 trimming rules).

/// <summary>One species column in the HUD and the dashboard chart.</summary>
public enum EcoSpecies { Rabbit = 0, Deer = 1, Wolf = 2, Human = 3 }

/// <summary>
/// The species vocabulary the UI needs: the plural the sim uses in its log, and the token
/// each species is drawn with. One table, so adding a species is one edit rather than five.
/// </summary>
public static class EcoSpeciesInfo
{
    public const int Count = 4;

    public static readonly string[] Plural = ["Rabbits", "Deer", "Wolves", "Humans"];

    public static readonly string[] Colour =
    [
        "var(--accent-warning)", "var(--accent-success)", "var(--accent-danger)", "var(--accent)",
    ];

    public static string PluralOf(int species) => Plural[Math.Clamp(species, 0, Count - 1)];
    public static string ColourOf(int species) => Colour[Math.Clamp(species, 0, Count - 1)];
}

/// <summary>World counters pushed twice a second by the sim worker.</summary>
public sealed record EcoStats(
    int Tick,
    int Speed,
    int Year,
    int Day,
    double DayFraction,
    int Alive,
    int Huts,
    int[] Counts,
    bool[] Extinct,
    int LastStanding,
    bool Silent,
    int Carcasses,
    double SimLag,
    bool LlmEnabled,
    EcoLlmCounters Llm,
    int[] PopHistory,
    EcoNaturalEvents NaturalEvents,
    EcoAlmanac? Almanac = null);

/// <summary>
/// Lifetime world counters for the dashboard's almanac panel (sim/world.js). Stages is the
/// age pyramid flattened species-major: [species * 3 + (0 young, 1 adult, 2 old)].
/// </summary>
public sealed record EcoAlmanac(
    int[] Born,
    int[] Died,
    Dictionary<string, int> ByCause,
    int[] Stages,
    int HutsBuilt,
    int TreesFelled,
    string OldestName,
    int OldestSpecies,
    double OldestAge);

/// <summary>One entry in the island-wide thought feed (dashboard).</summary>
public sealed record EcoThought(int Id, int Tick, int Handle, string Name, int Species, int Source, string Text);

public sealed record EcoLlmCounters(int Requested, int Applied, int Rejected);

public sealed record EcoNaturalEvents(int Lightning, int Rockslide, int Eruption);

/// <summary>One line in the world log / HUD toasts.</summary>
public sealed record EcoEvent(int Id, int Tick, string Kind, string Text, int? Species, string? Cause);

/// <summary>Everything the inspector popover shows about the creature under the crosshair.</summary>
public sealed record EcoDetail(
    int Handle,
    string Name,
    int Species,
    string SpeciesName,
    int Sex,
    double AgeYears,
    int LifeStage,
    double Hunger,
    double Thirst,
    double Health,
    double[] Traits,
    double[] BaseTraits,
    EcoNudge? Nudge,
    string Goal,
    string LastThought,
    int LastThoughtSource,
    string Mother,
    string Father,
    double X,
    double Y,
    double Z);

public sealed record EcoNudge(string Trait, double Delta);

/// <summary>The in-browser model's state, for the settings panel.</summary>
public sealed record EcoLlmState(string State, string ModelId, double Progress, string Message);

/// <summary>One selectable model (id, label, VRAM in MB, one-line note).</summary>
public sealed record EcoModel(string Id, string Label, int VramMb, string Note);

/// <summary>Result of probing IndexedDB for a saved world.</summary>
public sealed record EcoSaveInfo(bool Exists, int Seed, int Tick, int Year, long SavedAt, int[]? Counts);

[JsonSerializable(typeof(EcoStats))]
[JsonSerializable(typeof(EcoEvent[]))]
[JsonSerializable(typeof(EcoDetail))]
[JsonSerializable(typeof(EcoLlmState))]
[JsonSerializable(typeof(EcoModel[]))]
[JsonSerializable(typeof(EcoSaveInfo))]
[JsonSerializable(typeof(EcoAlmanac))]
[JsonSerializable(typeof(EcoThought[]))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true)]
internal sealed partial class EcoJsonContext : System.Text.Json.Serialization.JsonSerializerContext;
