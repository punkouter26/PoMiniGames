namespace PoMiniGames.Shared.Games;

/// <summary>
/// Sin, Cos and Atan2 from + − × ÷, floor and sqrt only, which IEEE 754 pins to the last bit.
/// Track geometry is built from the same code in the browser (Mono on WebAssembly) and on the
/// server (CoreCLR), whose Math.Sin / Math.Atan2 may disagree in the last bit; a kerb or a knot
/// built from that one bit apart would be a different track to the lap verifier. Same
/// operations, in the same order, as PoCabinetTrack's and track.js's own.
/// </summary>
public static class PoCabinetDetMath
{
    private const double HalfPi = Math.PI / 2;

    private static double SinShifted(double a, int quarter)
    {
        double k = Math.Floor(a / HalfPi + 0.5);
        double r = a - k * HalfPi;
        double r2 = r * r;
        double q = (((k + quarter) % 4) + 4) % 4;
        if (q == 0 || q == 2)
        {
            double s = r * (1 - r2 / 6 * (1 - r2 / 20 * (1 - r2 / 42 * (1 - r2 / 72 * (1 - r2 / 110 * (1 - r2 / 156 * (1 - r2 / 210)))))));
            return q == 0 ? s : -s;
        }
        double c = 1 - r2 / 2 * (1 - r2 / 12 * (1 - r2 / 30 * (1 - r2 / 56 * (1 - r2 / 90 * (1 - r2 / 132 * (1 - r2 / 182 * (1 - r2 / 240)))))));
        return q == 1 ? c : -c;
    }

    public static double Sin(double a) => SinShifted(a, 0);

    public static double Cos(double a) => SinShifted(a, 1);

    private static double AtanUnit(double z)
    {
        double t = z / (1 + Math.Sqrt(1 + z * z));
        t = t / (1 + Math.Sqrt(1 + t * t));
        t = t / (1 + Math.Sqrt(1 + t * t));
        double t2 = t * t;
        return 8 * t * (1 - t2 * (1.0 / 3 - t2 * (1.0 / 5 - t2 * (1.0 / 7 - t2 * (1.0 / 9 - t2 * (1.0 / 11 - t2 * (1.0 / 13 - t2 / 15)))))));
    }

    public static double Atan2(double y, double x)
    {
        double ax = Math.Abs(x), ay = Math.Abs(y);
        if (ax >= ay)
        {
            if (ax == 0) return 0;
            double a = AtanUnit(y / x);
            return x > 0 ? a : y >= 0 ? a + Math.PI : a - Math.PI;
        }
        double b = AtanUnit(x / y);
        return y > 0 ? HalfPi - b : -HalfPi - b;
    }
}
