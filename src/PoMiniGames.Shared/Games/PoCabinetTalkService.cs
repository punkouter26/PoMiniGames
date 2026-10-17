using System.Globalization;

namespace PoMiniGames.Shared.Games;

/// <summary>
/// The officials' radio lines and the "race engineer" debrief, both scripted: the radio pool is
/// the hand-written <see cref="PoCabinetDialogue"/> (ADR-4, "scripted dialogue only"), and the
/// debrief turns the race numbers into tips by thresholds. No model and no server is called —
/// the solo race runs both in the browser.
/// </summary>
public static class PoCabinetTalkService
{
    // Client wire kind -> the dialogue kind it draws from, in the order the client asks for them.
    private static readonly (string Wire, DialogueKind Kind)[] KindMap =
    [
        ("preRace", DialogueKind.PreRace),
        ("passed", DialogueKind.PositionChange),
        ("lead", DialogueKind.LapFinish),
        ("finish", DialogueKind.RaceFinish),
    ];

    /// <summary>The kinds a pool carries, in the order the client asks for them.</summary>
    public static IEnumerable<string> Kinds => KindMap.Select(k => k.Wire);

    // Built once: the pools are constants, so every race can share the same pool.
    private static readonly PoCabinetBanterPool Pool = BuildPool();

    /// <summary>The hand-written pools, mapped onto the client's kinds.</summary>
    public static PoCabinetBanterPool Banter() => Pool;

    private static PoCabinetBanterPool BuildPool()
    {
        var pool = new PoCabinetBanterPool();
        foreach (var (id, byKind) in PoCabinetDialogue.Pools)
        {
            pool.Lines[id] = KindMap.ToDictionary(
                k => k.Wire,
                k => byKind.GetValueOrDefault(k.Kind)?.ToList() ?? [],
                StringComparer.Ordinal);
        }
        return pool;
    }

    /// <summary>A request with every number clamped and the track resolved from the catalog.</summary>
    public sealed record Facts(
        string TrackName, int Position, int TotalCars, double BestLap, double Pb, double[] Sectors,
        int FullThrottle, int Brake, int TopKmh, int SlowestKmh, int WorstPoint, int WallHits, int Laps);

    public static PoCabinetDebriefReply Debrief(PoCabinetDebriefRequest request) => Debrief(Clamp(request));

    public static Facts Clamp(PoCabinetDebriefRequest r)
    {
        static double Sec(double v, double max) => double.IsFinite(v) ? Math.Clamp(Math.Round(v, 2), 0, max) : 0;
        static int Pct(int v) => Math.Clamp(v, 0, 100);
        var track = PoCabinetCatalog.GetTrack(r.TrackId);
        var sectors = r.SectorDeltas is { Length: 3 } s && s.All(double.IsFinite)
            ? s.Select(d => Math.Clamp(Math.Round(d, 2), -30, 30)).ToArray()
            : [];
        var total = Math.Clamp(r.TotalCars, 1, PoCabinetCatalog.SoloCarCount);
        return new Facts(
            track.Name, Math.Clamp(r.Position, 1, total), total, Sec(r.BestLapSeconds, 600), Sec(r.PbSeconds, 600), sectors,
            Pct(r.FullThrottlePct), Pct(r.BrakePct), Math.Clamp(r.TopKmh, 0, 400), Math.Clamp(r.SlowestKmh, 0, 400),
            Math.Clamp(r.WorstPointPct, -1, 100), Math.Clamp(r.WallHits, 0, 99), Math.Clamp(r.Laps, 0, 9));
    }

    /// <summary>The same numbers, turned into tips by thresholds.</summary>
    public static PoCabinetDebriefReply Debrief(Facts f)
    {
        var inv = CultureInfo.InvariantCulture;
        var tips = new List<string>();
        if (f.Sectors.Length == 3)
        {
            var worst = Array.IndexOf(f.Sectors, f.Sectors.Max());
            var best = Array.IndexOf(f.Sectors, f.Sectors.Min());
            if (f.Sectors[worst] > 0.05)
                tips.Add(string.Format(inv, "Sector {0} cost you {1:0.00} s against your best — that's where this lap is.", worst + 1, f.Sectors[worst]));
            if (f.Sectors[best] < -0.05)
                tips.Add(string.Format(inv, "Sector {0} was {1:0.00} s quicker than your best. Keep that line.", best + 1, -f.Sectors[best]));
        }
        else if (f.WorstPoint >= 0)
        {
            tips.Add(string.Format(inv, "Most time went about {0}% of the way round — look at your braking into that corner.", f.WorstPoint));
        }
        if (f.WallHits > 0)
            tips.Add(string.Format(inv, "{0} barrier hit{1} cost you speed: a tidier line beats a braver one.", f.WallHits, f.WallHits == 1 ? "" : "s"));
        if (f.FullThrottle < 55)
            tips.Add(string.Format(inv, "Flat out only {0}% of the lap — get back on the gas earlier out of the corners.", f.FullThrottle));
        if (f.Brake > 18)
            tips.Add(string.Format(inv, "On the brakes {0}% of the lap: brake later and harder, then let go.", f.Brake));
        if (f.SlowestKmh is > 0 and < 90)
            tips.Add(string.Format(inv, "Your slowest corner dropped to {0} km/h — carry more speed through it.", f.SlowestKmh));
        if (tips.Count == 0) tips.Add("A clean race. Next step: move each braking point a car length later.");

        var headline = f.Position == 1
            ? $"OFFICIALS STUNNED AS CHALLENGER TAKES {f.TrackName.ToUpperInvariant()}"
            : $"P{f.Position} AT {f.TrackName.ToUpperInvariant()}: CABINET DEMANDS A RECOUNT";
        return new PoCabinetDebriefReply(headline, tips.Take(3).ToList());
    }
}
