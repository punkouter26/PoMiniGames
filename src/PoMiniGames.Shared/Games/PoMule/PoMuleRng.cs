namespace PoMiniGames.Shared.Games.PoMule;

/// <summary>
/// The one source of randomness in a PoMule match (xorshift64).
/// </summary>
/// <remarks>
/// Hand-written rather than <see cref="Random"/> because a saved match stores
/// <see cref="State"/> and must continue the same sequence after a reload, on any .NET
/// version. <c>new Random(seed)</c> does not promise that.
/// </remarks>
public sealed class PoMuleRng
{
    /// <summary>For a saved match: the loader sets <see cref="State"/> straight after.</summary>
    [System.Text.Json.Serialization.JsonConstructor]
    public PoMuleRng() : this(0) { }

    public PoMuleRng(ulong seed) => State = seed == 0 ? 0x9E3779B97F4A7C15UL : seed;

    /// <summary>Everything needed to resume the sequence. Never zero.</summary>
    public ulong State { get; set; }

    public uint Next()
    {
        var s = State;
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        State = s;
        return (uint)(s >> 32);
    }

    /// <summary>A value in <c>[0, max)</c>.</summary>
    public int Next(int max) => (int)(Next() % (uint)max);

    public void Shuffle<T>(IList<T> items)
    {
        for (var i = items.Count - 1; i > 0; i--)
        {
            var j = Next(i + 1);
            (items[i], items[j]) = (items[j], items[i]);
        }
    }

    /// <summary>True with the given probability in percent.</summary>
    public bool Chance(int percent) => Next(100) < percent;
}
