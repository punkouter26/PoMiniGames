namespace PoMiniGames.Shared.Games.PoMule;

public enum ColonyEvent : byte { None, SolarFlare, AcidRain, PestAttack, Planetquake, SpacePirates, StoreFire }

/// <summary>
/// The monthly colony event. Weather events bend that month's production
/// (<see cref="PoMuleProduction.Run"/>); the rest strike afterwards (<see cref="Aftermath"/>).
/// </summary>
public static class PoMuleEvents
{
    public static ColonyEvent Roll(PoMuleRng rng) =>
        rng.Chance(PoMuleTuning.EventChancePercent) ? (ColonyEvent)(1 + rng.Next(6)) : ColonyEvent.None;

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
        }
    }

    public static string Headline(ColonyEvent colonyEvent) => colonyEvent switch
    {
        ColonyEvent.SolarFlare => "Solar Flare",
        ColonyEvent.AcidRain => "Acid Rain",
        ColonyEvent.PestAttack => "Pest Attack",
        ColonyEvent.Planetquake => "Planetquake",
        ColonyEvent.SpacePirates => "Space Pirates",
        ColonyEvent.StoreFire => "Store Fire",
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
        _ => "Nothing happened on Irata.",
    };
}
