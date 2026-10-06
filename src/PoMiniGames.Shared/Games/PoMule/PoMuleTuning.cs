namespace PoMiniGames.Shared.Games.PoMule;

/// <summary>
/// Every balance number in PoMule, in one place. Values the PRD did not define are the
/// "proposed" ones from SPEC.md §6; the 100-match balance test is what holds them honest.
/// </summary>
public static class PoMuleTuning
{
    public const int Seats = 8;
    public const int Months = 12;
    public const int TicksPerSecond = 10;

    // Phase lengths, seconds.
    /// <summary>Ticks the land-grant highlighter rests on each free plot (five plots a second).</summary>
    public const int LandStepTicks = 2;
    public const int AuctionSeconds = 20;
    public const int DevelopmentSeconds = 45;
    public const int MarketSeconds = 12;
    public const int ProductionSeconds = 6;
    public const int EventSeconds = 4;
    public const int StandingsSeconds = 6;

    // Starting position.
    public const int StartFood = 4;
    public const int StartEnergy = 2;
    public static readonly IReadOnlyList<int> StoreStartStock = [32, 32, 0, 0];
    public static readonly IReadOnlyList<int> StoreStartPrice = [30, 25, 50, 100];
    public const int StoreStartMules = 28;
    public const int MuleStartPrice = 100;

    // Outfitting a M.U.L.E. for Food / Energy / Smithore / Crystite.
    public static readonly IReadOnlyList<int> OutfitCost = [25, 50, 75, 100];

    // Land.
    public const int AuctionOpeningBid = 160;
    public const int AuctionPlotsPerEvenMonth = 2;

    public const int AuctionRaise = 10;

    // AI timing, in clock ticks left: the Gambler works only the first 15 s; the Agitator
    // and the Prospector give up their errands with 15 s to go and head for the pub.
    public const int GamblerWorksUntilTicks = 300;
    public const int AgitatorHuntsUntilTicks = 150;

    // Development.
    public const int PubCap = 250;
    public const int MinSpeedPercent = 40;

    // Production and events.
    public const int WarehouseCap = 50;
    public const int EventChancePercent = 75;

    /// <summary>This many colonists short of Food or Energy in one month is a colony crisis.</summary>
    public const int CrisisShortColonists = 3;

    // Market. Limits on the Store's buying price for Food / Energy / Smithore / Crystite.
    public static readonly IReadOnlyList<int> PriceMin = [15, 15, 25, 40];
    public static readonly IReadOnlyList<int> PriceMax = [150, 150, 250, 90];
    public const int SmithorePerMule = 2;

    /// <summary>Clock ticks left when sellers of Food and Energy give up waiting for a buyer.</summary>
    public const int MarketLastCallTicks = 50;

    /// <summary>Food and Energy an AI colonist will not sell, beyond next month's need.</summary>
    public static readonly IReadOnlyList<int> AiReserve = [2, 3];

    /// <summary>Smithore price × M.U.L.E.s in the corral: 7 M.U.L.E.s price Smithore at 50.</summary>
    public const int SmithorePriceTimesMules = 350;

    // Scoring.
    public const int LandValue = 500;
    public const int MuleValue = 350;
    public const int FederationTarget = 60_000;
    public const int MaxCrisisMonths = 1;

    /// <summary>Food a colonist must hold to work a full month: 3, then 4, then 5.</summary>
    public static int FoodNeed(int month) => 3 + (Math.Clamp(month, 1, Months) - 1) / 4;
}
