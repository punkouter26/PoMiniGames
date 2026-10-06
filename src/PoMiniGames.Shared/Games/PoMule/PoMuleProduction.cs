namespace PoMiniGames.Shared.Games.PoMule;

/// <summary>What one month's production did, for the renderer to animate.</summary>
/// <param name="Produced">Units made, by seat then by <see cref="Good"/>.</param>
/// <param name="IdleMules">M.U.L.E.s per seat that sat idle for lack of Energy.</param>
/// <param name="IdlePlots">The plots those M.U.L.E.s stand on.</param>
/// <param name="PestPlot">The plot a Pest Attack stripped, or -1.</param>
/// <param name="PlotOutput">Units each plot made (0 for idle or empty plots), for the unit-by-unit count on the map.</param>
public sealed record ProductionReport(int[][] Produced, int[] IdleMules, IReadOnlyList<int> IdlePlots, int PestPlot, int[] PlotOutput);

public static class PoMuleProduction
{
    /// <summary>What a M.U.L.E. outfitted for <paramref name="good"/> makes on this plot in a plain month.</summary>
    public static int BaseYield(Plot plot, Good good) => (good, plot.Terrain) switch
    {
        (_, Terrain.Town) => 0,
        // Nothing can be mined out of a river.
        (Good.Smithore or Good.Crystite, Terrain.River) => 0,
        (Good.Crystite, _) => plot.Crystite,
        (Good.Food, Terrain.River) => 4,
        (Good.Food, Terrain.Plains) => 2,
        (Good.Food, _) => 1,
        (Good.Energy, Terrain.River) => 2,
        (Good.Energy, Terrain.Plains) => 3,
        (Good.Energy, _) => 1,
        (Good.Smithore, Terrain.Mountain) => 1 + plot.Peaks,
        _ => 1,
    };

    /// <summary>
    /// Economies of scale, as in the original: a unit more when a neighbouring plot of the
    /// same owner makes the same good, and a unit more for every three plots they have on it.
    /// </summary>
    public static int ScaleBonus(MatchState match, int plot)
    {
        var (owner, good) = (match.Owner[plot], match.Installed[plot]);
        bool Same(int i) => match.Owner[i] == owner && match.Installed[i] == good;

        var (column, row) = (plot % PoMuleMap.Columns, plot - plot % PoMuleMap.Columns);
        var neighbour = Same(row + (column + 1) % PoMuleMap.Columns)
            || Same(row + (column + PoMuleMap.Columns - 1) % PoMuleMap.Columns)
            || (plot >= PoMuleMap.Columns && Same(plot - PoMuleMap.Columns))
            || (plot + PoMuleMap.Columns < match.Owner.Length && Same(plot + PoMuleMap.Columns));
        return (neighbour ? 1 : 0) + Enumerable.Range(0, match.Owner.Length).Count(Same) / 3;
    }

    private static int Weather(int units, Plot plot, Good good, ColonyEvent weather) => (weather, good) switch
    {
        (ColonyEvent.SolarFlare, Good.Energy) => units * 3 / 2,
        (ColonyEvent.AcidRain, Good.Food) when plot.Terrain == Terrain.River => units * 3 / 2,
        (ColonyEvent.AcidRain, Good.Energy) => units / 2,
        (ColonyEvent.Planetquake, Good.Smithore or Good.Crystite) => units / 2,
        _ => units,
    };

    /// <summary>
    /// Runs the month's production: yields, the Energy bill, species bonuses, spoilage, and
    /// the colony-crisis count.
    /// </summary>
    /// <param name="vary">Each plot swings one unit either way. Tests switch it off for exact sums.</param>
    public static ProductionReport Run(MatchState match, ColonyEvent weather, bool vary = true)
    {
        var plots = match.Map.Plots;
        var output = new int[plots.Length];
        for (var i = 0; i < plots.Length; i++)
        {
            if (match.Installed[i] == MatchState.Nobody) continue;
            var good = (Good)match.Installed[i];
            var units = BaseYield(plots[i], good);
            if (vary && units > 0) units += match.Rng.Next(3) - 1;
            if (units > 0) units = Math.Min(PoMuleTuning.MaxPlotYield, units + ScaleBonus(match, i));
            output[i] = Weather(units, plots[i], good, weather);
        }

        var pestPlot = -1;
        if (weather == ColonyEvent.PestAttack)
        {
            var farms = Worked(match).Where(i => match.Installed[i] == (sbyte)Good.Food && output[i] > 0).ToList();
            if (farms.Count > 0)
            {
                var victim = match.Owner[farms[match.Rng.Next(farms.Count)]];
                pestPlot = farms.Where(i => match.Owner[i] == victim).MaxBy(i => output[i]);
                output[pestPlot] = 0;
            }
        }

        var produced = new int[match.Players.Length][];
        var idleMules = new int[match.Players.Length];
        var idlePlots = new List<int>();
        foreach (var player in match.Players)
        {
            if (match.Has(player, Species.Voltronix)) player.Goods[(int)Good.Energy]++;

            // Every M.U.L.E. that is not making Energy burns one. Short of it, the ones whose
            // output is worth least at the Store are the ones left idle.
            var consumers = Worked(match)
                .Where(i => match.Owner[i] == player.Seat && match.Installed[i] != (sbyte)Good.Energy)
                .OrderBy(i => output[i] * match.Store.Price[match.Installed[i]]).ThenBy(i => i)
                .ToList();
            var idle = Math.Max(0, consumers.Count - player.Goods[(int)Good.Energy]);
            foreach (var i in consumers.Take(idle))
            {
                output[i] = 0;
                idlePlots.Add(i);
            }
            idleMules[player.Seat] = idle;
            if (idle > 0) player.WentShort = true;
            player.Goods[(int)Good.Energy] -= consumers.Count - idle;

            var made = new int[4];
            var riverFood = 0;
            foreach (var i in Worked(match).Where(i => match.Owner[i] == player.Seat))
            {
                made[match.Installed[i]] += output[i];
                if (match.Installed[i] == (sbyte)Good.Food && plots[i].Terrain == Terrain.River) riverFood += output[i];
            }
            if (match.Has(player, Species.Gollumoid)) made[(int)Good.Food] += Bonus(riverFood);
            if (match.Has(player, Species.OreGorger)) made[(int)Good.Smithore] += Bonus(made[(int)Good.Smithore]);
            produced[player.Seat] = made;

            for (var g = 0; g < 4; g++)
            {
                var need = (Good)g switch
                {
                    Good.Food => PoMuleTuning.FoodNeed(match.Month + 1),
                    Good.Energy => consumers.Count,
                    _ => 0,
                };
                player.Goods[g] = AfterSpoilage((Good)g, player.Goods[g] + made[g], need);
            }
        }

        if (match.Players.Count(p => p.WentShort) >= PoMuleTuning.CrisisShortColonists) match.CrisisMonths++;
        return new ProductionReport(produced, idleMules, idlePlots, pestPlot, output);
    }

    /// <summary>
    /// What is left of a stockpile after a month in storage: half the Food and a quarter of
    /// the Energy beyond next month's need is lost, and the warehouse holds only so much ore.
    /// </summary>
    public static int AfterSpoilage(Good good, int held, int need) => good switch
    {
        Good.Food => held - Math.Max(0, held - need) / 2,
        Good.Energy => held - Math.Max(0, held - need) / 4,
        _ => Math.Min(held, PoMuleTuning.WarehouseCap),
    };

    private static IEnumerable<int> Worked(MatchState match) =>
        Enumerable.Range(0, match.Installed.Length).Where(i => match.Installed[i] != MatchState.Nobody);

    /// <summary>A 15% species bonus, rounded to the nearest unit.</summary>
    private static int Bonus(int units) => (units * 15 + 50) / 100;
}
