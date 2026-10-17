namespace PoMiniGames.Shared;

/// <summary>
/// 32-bit FNV-1a, for picking a scripted line that stays the same across processes, restarts
/// and the browser. <see cref="string.GetHashCode()"/> and <c>HashCode.Combine</c> are seeded
/// randomly per process, so "the same fight reads the same line" would hold only until the
/// next reload.
/// </summary>
public static class StableHash
{
    /// <summary>The FNV-1a offset basis: the hash of nothing.</summary>
    public const uint Seed = 2166136261;
    private const uint Prime = 16777619;

    /// <summary>The hash of <paramref name="text"/>, one UTF-16 unit per step.</summary>
    public static uint Of(string text) => Add(Seed, text);

    /// <summary>Folds <paramref name="text"/> into <paramref name="hash"/>, one UTF-16 unit per step.</summary>
    public static uint Add(uint hash, string text)
    {
        foreach (var c in text) hash = (hash ^ c) * Prime;
        return hash;
    }

    /// <summary>Folds <paramref name="value"/> into <paramref name="hash"/> as one step.</summary>
    public static uint Add(uint hash, uint value) => (hash ^ value) * Prime;

    /// <summary>Folds the four little-endian bytes of <paramref name="value"/> into <paramref name="hash"/>.</summary>
    public static uint AddBytes(uint hash, int value)
    {
        for (var shift = 0; shift < 32; shift += 8) hash = (hash ^ (byte)(value >> shift)) * Prime;
        return hash;
    }

    /// <summary>The item <paramref name="hash"/> lands on.</summary>
    public static T Pick<T>(IReadOnlyList<T> items, uint hash) => items[(int)(hash % (uint)items.Count)];
}
