namespace PoMiniGames.Shared.Games.PoMule;

public enum ColonyEvent : byte { None, SolarFlare, AcidRain, PestAttack, Planetquake, SpacePirates, StoreFire, Meteor, Radiation, ShipReturns }

/// <summary>A stroke of personal luck. Everything before <see cref="Elves"/> is good news.</summary>
public enum LuckKind : byte
{
    CarePackage, Traveler, TapDance, FoodGrant, Museum, EelContest, MooseRat, ExtraPlot,
    Elves, LostBolt, MiningRepair, SolarCleaning, CatBugs, Kazinga, LostPlot,
}

/// <summary>
/// The monthly colony event. Weather events bend that month's production
/// (<see cref="PoMuleProduction.Run"/>); the rest strike afterwards (<see cref="Aftermath"/>).
/// </summary>
public static class PoMuleEvents
{
    private const int LuckKinds = (int)LuckKind.LostPlot + 1;

    /// <summary>
    /// This month's event. No event strikes more often than its cap allows, and the last
    /// month has none: the ship comes back instead.
    /// </summary>
    public static ColonyEvent Roll(MatchState match)
    {
        if (match.Month >= PoMuleTuning.Months) return ColonyEvent.ShipReturns;
        if (!match.Rng.Chance(PoMuleTuning.EventChancePercent)) return ColonyEvent.None;

        var open = Enumerable.Range(1, (int)ColonyEvent.Radiation)
            .Where(e => match.EventCounts[e] < PoMuleTuning.EventCap[e]).ToList();
        if (open.Count == 0) return ColonyEvent.None;
        var colonyEvent = open[match.Rng.Next(open.Count)];
        match.EventCounts[colonyEvent]++;
        return (ColonyEvent)colonyEvent;
    }

    /// <summary>Applies the events that take things away once production is in.</summary>
    public static void Aftermath(MatchState match, ColonyEvent colonyEvent)
    {
        match.EventPlot = -1;
        switch (colonyEvent)
        {
            case ColonyEvent.SpacePirates:
                foreach (var player in match.Players) player.Goods[(int)Good.Crystite] = 0;
                break;
            case ColonyEvent.StoreFire:
                match.Store.Stock[(int)Good.Food] = 0;
                match.Store.Stock[(int)Good.Energy] = 0;
                match.Store.Stock[(int)Good.Smithore] = 0;
                break;
            case ColonyEvent.Meteor:
                // A meteor digs a rich crater in open ground nobody owns.
                match.EventPlot = Pick(match, i => PoMuleLand.Claimable(match, i) && match.Map.Plots[i].Terrain is Terrain.Plains or Terrain.Mountain);
                if (match.EventPlot >= 0) match.Map.Plots[match.EventPlot] = new Plot(Terrain.Crater, 0, 4);
                break;
            case ColonyEvent.Radiation:
                // One M.U.L.E. somewhere goes crazy and is gone; its plot stands empty.
                match.EventPlot = Pick(match, i => match.Installed[i] != MatchState.Nobody);
                if (match.EventPlot >= 0) match.Installed[match.EventPlot] = MatchState.Nobody;
                break;
        }
    }

    /// <summary>A random plot that passes, or -1.</summary>
    private static int Pick(MatchState match, Func<int, bool> passes)
    {
        var plots = Enumerable.Range(0, match.Owner.Length).Where(passes).ToList();
        return plots.Count == 0 ? -1 : plots[match.Rng.Next(plots.Count)];
    }

    /// <summary>
    /// A stroke of personal luck between turns, as in the original: good luck never finds
    /// the leader and bad luck never the colonist in last place.
    /// </summary>
    /// <returns>
    /// Who, what, and how much: credits for the cash events, units of Food for
    /// <see cref="LuckKind.Elves"/>, otherwise 0.
    /// </returns>
    public static (int Seat, LuckKind Kind, int Amount) Luck(MatchState match)
    {
        var ranked = PoMuleScoring.Standings(match);
        var good = match.Rng.Chance(50);
        var seat = ranked[(good ? 1 : 0) + match.Rng.Next(ranked.Count - 1)].Seat;
        var kind = (LuckKind)(good ? match.Rng.Next((int)LuckKind.Elves) : (int)LuckKind.Elves + match.Rng.Next(LuckKinds - (int)LuckKind.Elves));

        var player = match.Players[seat];
        var unit = PoMuleTuning.LuckCredits * (1 + (match.Month - 1) / 4);
        int Working(params Good[] goods) => Enumerable.Range(0, match.Owner.Length)
            .Count(i => match.Owner[i] == seat && goods.Contains((Good)match.Installed[i]));

        // Luck that has nothing to land on becomes the plain cash kind.
        var plot = kind switch
        {
            LuckKind.ExtraPlot => Pick(match, i => PoMuleLand.Claimable(match, i)),
            LuckKind.LostPlot => Pick(match, i => match.Owner[i] == seat && match.Installed[i] == MatchState.Nobody),
            _ => -1,
        };
        var mules = kind switch
        {
            LuckKind.FoodGrant => Working(Good.Food),
            LuckKind.MiningRepair => Working(Good.Smithore, Good.Crystite),
            LuckKind.SolarCleaning => Working(Good.Energy),
            _ => 0,
        };
        var empty = kind switch
        {
            LuckKind.ExtraPlot or LuckKind.LostPlot => plot < 0,
            LuckKind.FoodGrant or LuckKind.MiningRepair or LuckKind.SolarCleaning => mules == 0,
            LuckKind.Elves => player.Goods[(int)Good.Food] < 2,
            _ => false,
        };
        if (empty) kind = good ? LuckKind.EelContest : LuckKind.Kazinga;

        var credits = kind switch
        {
            LuckKind.TapDance => unit * 4,
            LuckKind.FoodGrant => unit * 2 * mules,
            LuckKind.Museum => unit * 8,
            LuckKind.EelContest or LuckKind.MooseRat => unit * 2,
            LuckKind.LostBolt => -unit * 3,
            LuckKind.MiningRepair or LuckKind.SolarCleaning => -unit * mules,
            LuckKind.CatBugs or LuckKind.Kazinga => -unit * 4,
            _ => 0,
        };
        credits = Math.Max(credits, -player.Cash);
        player.Cash += credits;

        var amount = Math.Abs(credits);
        switch (kind)
        {
            case LuckKind.CarePackage:
                player.Goods[(int)Good.Food] += 3;
                player.Goods[(int)Good.Energy] += 2;
                break;
            case LuckKind.Traveler:
                player.Goods[(int)Good.Smithore] += 2;
                break;
            case LuckKind.Elves:
                amount = player.Goods[(int)Good.Food] / 2;
                player.Goods[(int)Good.Food] -= amount;
                break;
            case LuckKind.ExtraPlot:
                match.Owner[plot] = (sbyte)seat;
                break;
            case LuckKind.LostPlot:
                match.Owner[plot] = MatchState.Nobody;
                break;
        }
        return (seat, kind, amount);
    }

    /// <summary>The line for the message bar. Kept short: the bar holds 63 characters.</summary>
    public static string LuckText(LuckKind kind, string who, int amount) => kind switch
    {
        LuckKind.CarePackage => $"{who} got a care package: 3 Food, 2 Energy.",
        LuckKind.Traveler => $"A space traveler left {who} 2 Smithore.",
        LuckKind.TapDance => $"{who}'s M.U.L.E. won the tap-dance contest: ${amount}.",
        LuckKind.FoodGrant => $"The council paid {who} ${amount} for growing Food.",
        LuckKind.Museum => $"The museum bought {who}'s antique computer: ${amount}.",
        LuckKind.EelContest => $"{who} won the swamp eel eating contest: ${amount}. Yuck!",
        LuckKind.MooseRat => $"{who} sold a dead moose rat's hide for ${amount}.",
        LuckKind.ExtraPlot => $"{who} was granted an extra plot of land.",
        LuckKind.Elves => $"Glac-elves stole half of {who}'s Food.",
        LuckKind.LostBolt => $"{who}'s M.U.L.E. lost a bolt. Repairs: ${amount}.",
        LuckKind.MiningRepair => $"{who}'s mining M.U.L.E.s wore out. Repairs: ${amount}.",
        LuckKind.SolarCleaning => $"{who}'s solar collectors were dirty. Cleaning: ${amount}.",
        LuckKind.CatBugs => $"Cat-bugs ate the roof off {who}'s house: ${amount}.",
        LuckKind.Kazinga => $"{who} lost ${amount} on the two-legged kazinga races.",
        _ => $"{who} lost a plot: the claim was never recorded.",
    };

    public static string Headline(ColonyEvent colonyEvent) => colonyEvent switch
    {
        ColonyEvent.SolarFlare => "Solar Flare",
        ColonyEvent.AcidRain => "Acid Rain",
        ColonyEvent.PestAttack => "Pest Attack",
        ColonyEvent.Planetquake => "Planetquake",
        ColonyEvent.SpacePirates => "Space Pirates",
        ColonyEvent.StoreFire => "Store Fire",
        ColonyEvent.Meteor => "Meteor Strike",
        ColonyEvent.Radiation => "Radiation",
        ColonyEvent.ShipReturns => "The ship has returned",
        _ => "A quiet month",
    };

    public static string Detail(ColonyEvent colonyEvent) => colonyEvent switch
    {
        ColonyEvent.SolarFlare => "Energy output up by half.",
        ColonyEvent.AcidRain => "River Food up by half, Energy output halved.",
        ColonyEvent.PestAttack => "One colonist's best Food plot was stripped bare.",
        ColonyEvent.Planetquake => "Smithore and Crystite output halved.",
        ColonyEvent.SpacePirates => "Every colonist's Crystite was stolen.",
        ColonyEvent.StoreFire => "The Store's Food, Energy and Smithore burned.",
        ColonyEvent.Meteor => "Meteor makes new Crystite deposit.",
        ColonyEvent.Radiation => "A M.U.L.E. went crazy and ran off.",
        ColonyEvent.ShipReturns => "One last market, then the count.",
        _ => "Nothing happened on Irata.",
    };
}
