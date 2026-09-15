namespace PoMiniGames.Shared.Games.PoEcosystem;

// ───────────────────────────  PoEcosystem cloud contracts  ───────────────────────────
//
// Cloud saves and the chronicle are the only server surfaces the island has. Saves are
// opaque gzip'd snapshot bytes produced by the browser engine (js/poecosystem/sim/
// persistence/codec.js) — the server never parses a world, it stores blobs and the
// metadata rows the slot picker and the gallery render from.

/// <summary>Slot identifiers a caller may save into. Three, so the store stays bounded per identity.</summary>
public static class EcoWorldSlots
{
    public static readonly string[] All = ["1", "2", "3"];
    public const int MaxBytes = 12 * 1024 * 1024;
    public const int MaxNameChars = 40;
    public static bool IsValid(string? slot) => slot is not null && Array.IndexOf(All, slot) >= 0;
}

/// <summary>One of the caller's saved worlds, as the slot picker shows it.</summary>
public sealed record EcoWorldMeta(
    string Slot,
    string Name,
    int Seed,
    int Year,
    int Tick,
    int[] Counts,
    DateTimeOffset SavedAt,
    long SizeBytes,
    string? ShareCode,
    string? OwnerName);

/// <summary>A world its owner made public, as the gallery lists it.</summary>
public sealed record EcoSharedWorld(
    string Code,
    string Name,
    string OwnerName,
    int Seed,
    int Year,
    int[] Counts,
    DateTimeOffset SavedAt,
    long SizeBytes);

public sealed record EcoShareRequest(bool Public);

/// <summary>What the chronicler is handed: the decade's log, the counts, and who the tribe is.</summary>
public sealed record EcoChronicleRequest(
    int Seed,
    int FromYear,
    int ToYear,
    string Tribe,
    int[] Counts,
    bool[] Extinct,
    string[] Log,
    string? Almanac);

/// <summary>A decade of island history as a short saga.</summary>
public sealed record EcoChronicle(string Title, string Saga, string Epigraph, bool Mock, DateTimeOffset WrittenAt);

/// <summary>One creature's thought, asked of the server-side model when the browser cannot run one.</summary>
public sealed record EcoThoughtRequest(string System, string Prompt);

public sealed record EcoThoughtReply(string Text, bool Mock);
