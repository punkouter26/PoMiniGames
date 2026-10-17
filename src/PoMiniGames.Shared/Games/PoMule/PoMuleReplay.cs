using System.Text;

namespace PoMiniGames.Shared.Games.PoMule;

/// <summary>Everything the page can do to a match, as it appears in the action log.</summary>
/// <remarks>Logged as the letter <c>'A' + value</c>: append only, never renumber.</remarks>
public enum PoMuleCommand : byte
{
    LandPick, Arrive, Bump, Wampus, BuyMule, Outfit, Pub, Assay, Install, Survey, MarketInput, SkipStandings, Role,
}

/// <summary>
/// Plays a match again from its seed and action log, so the server can store the Net Worth the
/// rules give rather than the one the browser reports.
/// </summary>
/// <remarks>
/// Log format: entries joined by <c>'.'</c>, each <c>&lt;gap&gt;&lt;command&gt;&lt;arg&gt;</c>, where
/// gap is the ticks since the previous entry in lowercase base 36, command one capital letter
/// (<see cref="PoMuleCommand"/>), and arg a base-36 integer with an optional leading <c>'-'</c>.
/// An entry applies after that many ticks have been stepped, before the next one. The renderer's
/// reports (an AI arriving, a bump) are in the log too, so nothing the browser decided is missing.
/// </remarks>
public static class PoMuleReplay
{
    /// <summary>Far above a real log (a few kilobytes).</summary>
    public const int MaxLogLength = 256 * 1024;

    /// <summary>Far above a real match (about 25,000 ticks); bounds what one replay can cost.</summary>
    public const long MaxTicks = 400_000;

    /// <summary>The finished match, or null when the log is malformed or does not end the match within bounds.</summary>
    public static PoMuleMatch? Run(ulong seed, Species species, bool classic, string? log)
    {
        if (log is null || log.Length > MaxLogLength || !Enum.IsDefined(species)) return null;
        var match = PoMuleMatch.New(seed, species, classic: classic);
        long tick = 0;
        foreach (var entry in log.Split('.', StringSplitOptions.RemoveEmptyEntries))
        {
            if (!TryParse(entry, out var gap, out var command, out var arg)) return null;
            tick += gap;
            if (tick > MaxTicks) return null;
            while (match.State.Ticks < tick)
            {
                if (match.State.Phase == Phase.Finished) return null;
                match.Advance(1);
            }
            if (!match.Apply(command, arg)) return null;
        }
        while (match.State.Phase != Phase.Finished)
        {
            if (match.State.Ticks >= MaxTicks) return null;
            match.Advance(1);
        }
        return match;
    }

    internal static void AppendBase36(StringBuilder sb, long value)
    {
        if (value == 0) { sb.Append('0'); return; }
        Span<char> digits = stackalloc char[16];
        var n = 0;
        for (; value > 0; value /= 36) digits[n++] = (char)(value % 36 < 10 ? '0' + value % 36 : 'a' + value % 36 - 10);
        while (n > 0) sb.Append(digits[--n]);
    }

    private static bool TryParse(string entry, out long gap, out PoMuleCommand command, out int arg)
    {
        gap = 0;
        command = default;
        arg = 0;
        var i = 0;
        if (!ReadBase36(entry, ref i, 8, out gap)) return false;
        if (i >= entry.Length || entry[i] is < 'A' or > 'Z') return false;
        var letter = entry[i++] - 'A';
        if (!Enum.IsDefined((PoMuleCommand)letter)) return false;
        command = (PoMuleCommand)letter;
        var negative = i < entry.Length && entry[i] == '-';
        if (negative) i++;
        if (!ReadBase36(entry, ref i, 4, out var magnitude) || i != entry.Length) return false;
        arg = (int)(negative ? -magnitude : magnitude);
        return true;
    }

    private static bool ReadBase36(string text, ref int i, int maxDigits, out long value)
    {
        value = 0;
        var start = i;
        while (i < text.Length && i - start < maxDigits)
        {
            var c = text[i];
            int d = c is >= '0' and <= '9' ? c - '0' : c is >= 'a' and <= 'z' ? c - 'a' + 10 : -1;
            if (d < 0) break;
            value = value * 36 + d;
            i++;
        }
        return i > start;
    }
}
