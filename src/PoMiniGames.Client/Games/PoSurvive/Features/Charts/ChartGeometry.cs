namespace PoMiniGamesClient.Games.PoSurvive.Features.Charts;

using System.Globalization;

/// <summary>
/// Plot-area arithmetic shared by PoSurvive's charts.
///
/// Every chart draws into the same 320×140 user-space viewBox and scales with
/// `preserveAspectRatio` + `vector-effect="non-scaling-stroke"`, so strokes stay
/// exactly 2px at any rail width instead of being stretched by the container.
/// Keeping the numbers here means the axis rulers and the marks can never be
/// computed from two slightly different plot rectangles.
/// </summary>
public static class ChartGeometry
{
    public const double ViewW = 320;
    public const double ViewH = 140;

    /// <summary>Left edge of the plot area — leaves room for the Y tick labels.</summary>
    public const double Left = 30;
    /// <summary>
    /// Right edge. The 28 units between this and <see cref="ViewW"/> are the gutter
    /// the direct end labels sit in. At 314 they overflowed the viewBox and were
    /// clipped by the rail, so "R3" rendered as "R(".
    /// </summary>
    public const double Right = 292;
    public const double Top = 10;
    /// <summary>Bottom of the plot area. Below this sit the X tick labels.</summary>
    public const double Bottom = 112;

    public static double PlotW => Right - Left;
    public static double PlotH => Bottom - Top;

    /// <summary>Maps index i of n points onto the X axis. A single point sits at the left edge.</summary>
    public static double X(int i, int count)
        => count <= 1 ? Left : Left + (PlotW * i / (count - 1));

    /// <summary>Maps a value onto the Y axis. <paramref name="max"/> of 0 is treated as 1.</summary>
    public static double Y(double value, double max)
        => Bottom - (PlotH * (value / (max <= 0 ? 1 : max)));

    /// <summary>Invariant-culture SVG coordinate. A comma decimal separator silently voids the path.</summary>
    public static string N(double value)
        => value.ToString("F2", CultureInfo.InvariantCulture);

    public static string Point(double x, double y) => $"{N(x)},{N(y)}";

    /// <summary>
    /// Up to <paramref name="wanted"/> evenly spaced indices, always including the
    /// first and last. Used for X tick labels so a 300-turn run doesn't try to
    /// print 300 numbers on a 284-unit axis.
    /// </summary>
    public static IReadOnlyList<int> TickIndices(int count, int wanted = 4)
    {
        if (count <= 0) return [];
        if (count <= wanted) return [.. Enumerable.Range(0, count)];

        var step = (count - 1) / (double)(wanted - 1);
        return [.. Enumerable.Range(0, wanted)
            .Select(i => (int)Math.Round(i * step))
            .Distinct()];
    }

    /// <summary>
    /// Y-axis tick values from 0 to <paramref name="max"/>: 0, midpoint, max —
    /// dropping the midpoint when the axis is too short for it to be a whole number
    /// worth printing.
    /// </summary>
    public static IReadOnlyList<double> YTicks(double max)
    {
        if (max <= 0) return [0];
        if (max <= 2) return [0, max];
        return [0, Math.Round(max / 2), max];
    }
}
