namespace PoMiniGames.Shared.Games.PoMule;

public enum ColonyEvent : byte { None, SolarFlare, AcidRain, PestAttack, Planetquake, SpacePirates, StoreFire, Meteor }

/// <summary>
/// The monthly colony event. Weather events bend that month's production
/// (<see cref="PoMuleProduction.Run"/>); the rest strike afterwards (<see cref="Aftermath"/>).
/// </summary>
public static class PoMuleEvents
{
    public static ColonyEvent Roll(PoMuleRng rng) =>
        rng.Chance(PoMuleTuning.EventChancePercent) ? (ColonyEvent)(1 + rng.Next(7)) : ColonyEvent.None;

    /// <summary>Applies the events that take things away once production is in.</summary>
    public static void Aftermath(MatchState match, ColonyEvent colonyEvent)
    {
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
                var open = Enumerable.Range(0, match.Owner.Length)
                    .Where(i => PoMuleLand.Claimable(match, i) && match.Map.Plots[i].Terrain is Terrain.Plains or Terrain.Mountain).ToList();
                match.MeteorPlot = open.Count == 0 ? -1 : open[match.Rng.Next(open.Count)];
                if (match.MeteorPlot >= 0) match.Map.Plots[match.MeteorPlot] = new Plot(Terrain.Crater, 0, 4);
                break;
        }
    }

    /// <summary>
    /// A stroke of personal luck between turns, as in the original: good luck finds a
    /// colonist in the poorer half, bad luck one in the richer half, so it nudges the race
    /// closed rather than open. Returns the seat and the credits gained (negative = lost).
    /// </summary>
    public static (int Seat, int Credits) Luck(MatchState match)
    {
        var ranked = PoMuleScoring.Standings(match);
        var good = match.Rng.Chance(50);
        var seat = ranked[(good ? 4 : 0) + match.Rng.Next(4)].Seat;
        var player = match.Players[seat];
        var credits = PoMuleTuning.LuckCredits * (1 + (match.Month - 1) / 4);
        if (!good) credits = -Math.Min(credits, player.Cash);
        player.Cash += credits;
        return (seat, credits);
    }

    public static string Headline(ColonyEvent colonyEvent) => colonyEvent switch
    {
        ColonyEvent.SolarFlare => "Solar Flare",
        ColonyEvent.AcidRain => "Acid Rain",
        ColonyEvent.PestAttack => "Pest Attack",
        ColonyEvent.Planetquake => "Planetquake",
        ColonyEvent.SpacePirates => "Space Pirates",
        ColonyEvent.StoreFire => "Store Fire",
        ColonyEvent.Meteor => "Meteor Strike",
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
        _ => "Nothing happened on Irata.",
    };
}
