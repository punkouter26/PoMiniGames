namespace PoMiniGames.Shared.Games.PoMule;

/// <summary>The steps of a month, in order. <see cref="Auction"/> only runs on even months.</summary>
public enum Phase : byte { Land, Auction, Development, Production, Event, Market, Standings, Finished }

public sealed class PlayerState
{
    public int Seat { get; set; }
    public string Name { get; set; } = "";
    public Species Species { get; set; }
    public Archetype Archetype { get; set; }
    public int Cash { get; set; }

    /// <summary>Units held, indexed by <see cref="Good"/>.</summary>
    public int[] Goods { get; set; } = new int[4];

    // ── This month's development phase ──

    /// <summary>100 is full speed; 0 means starving and sitting the month out.</summary>
    public int SpeedPercent { get; set; } = 100;

    public bool HasMule { get; set; }

    /// <summary>The <see cref="Good"/> the towed M.U.L.E. is outfitted for, or -1 for a bare one.</summary>
    public sbyte Outfit { get; set; } = -1;

    /// <summary>Ran short of Food, or had a M.U.L.E. idle for lack of Energy, this month.</summary>
    public bool WentShort { get; set; }

    public bool InPub { get; set; }
    public bool HoldsAssay { get; set; }
}

/// <summary>The one Colony Store every town shares.</summary>
public sealed class StoreState
{
    public int[] Stock { get; set; } = [.. PoMuleTuning.StoreStartStock];
    public int[] Price { get; set; } = [.. PoMuleTuning.StoreStartPrice];
    public int Mules { get; set; } = PoMuleTuning.StoreStartMules;
    public int MulePrice { get; set; } = PoMuleTuning.MuleStartPrice;
}

/// <summary>
/// A whole match. Plain settable data so it can be saved between months and restored as is.
/// </summary>
public sealed class MatchState
{
    public const sbyte Nobody = -1;

    /// <summary>Bump when a rules change makes older saved matches unplayable; they are then discarded.</summary>
    public const int CurrentVersion = 1;

    public int Version { get; set; } = CurrentVersion;
    public ulong Seed { get; set; }
    public PoMuleRng Rng { get; set; } = new(1);
    public PoMuleMap Map { get; set; } = new([]);
    public PlayerState[] Players { get; set; } = [];

    /// <summary>Seat that owns each plot, or <see cref="Nobody"/>. Same indexing as the map.</summary>
    public sbyte[] Owner { get; set; } = [];

    /// <summary>The <see cref="Good"/> each plot's M.U.L.E. produces, or <see cref="Nobody"/>.</summary>
    public sbyte[] Installed { get; set; } = [];

    /// <summary>Plots whose Crystite level everyone can see.</summary>
    public bool[] Assayed { get; set; } = [];

    /// <summary>Ticks left in the current timed phase (ten to the second).</summary>
    public int ClockTicks { get; set; }

    public StoreState Store { get; set; } = new();
    public int Month { get; set; } = 1;
    public Phase Phase { get; set; } = Phase.Land;

    /// <summary>Months in which the colony as a whole was short of Food or Energy.</summary>
    public int CrisisMonths { get; set; }

    /// <summary>The plot the land-grant highlighter is on, or -1 outside that phase.</summary>
    public int LandCursor { get; set; } = -1;

    /// <summary>
    /// Land grant: for an AI, the plot it is waiting for; for the player, the plot they just
    /// pressed the button on (consumed on the next tick). -1 = none.
    /// </summary>
    public int[] LandPicks { get; set; } = Enumerable.Repeat(-1, PoMuleTuning.Seats).ToArray();

    public ColonyEvent LastEvent { get; set; }

    /// <summary>Net Worth of every seat at the end of each finished month, for the chart.</summary>
    public List<int[]> History { get; set; } = [];

    /// <summary>Plot on the auction block, or -1 when no auction is open.</summary>
    public int AuctionPlot { get; set; } = -1;
    public int HighBid { get; set; }
    public sbyte HighBidder { get; set; } = Nobody;

    /// <summary>The <see cref="Good"/> on the trading floor, or <see cref="Nobody"/>.</summary>
    public sbyte MarketGood { get; set; } = Nobody;

    /// <summary>Per seat: <see cref="PoMuleMarket.Seller"/>, <see cref="PoMuleMarket.Buyer"/>, or 0 for sitting out.</summary>
    public sbyte[] LaneRole { get; set; } = new sbyte[PoMuleTuning.Seats];

    /// <summary>Per seat: the price that seat is standing at on the floor.</summary>
    public int[] LanePrice { get; set; } = new int[PoMuleTuning.Seats];

    public int TradeMeter { get; set; }

    /// <param name="humanSpecies">The player's pick, or null for an all-AI demo match.</param>
    public static MatchState New(ulong seed, Species? humanSpecies)
    {
        var rng = new PoMuleRng(seed);
        var map = PoMuleMap.Generate(rng);

        var archetypes = Enum.GetValues<Archetype>().Where(a => a != Archetype.Human).ToList();
        rng.Shuffle(archetypes);
        // A demo has eight AI seats and seven personalities, so the seed picks one to repeat.
        archetypes.Insert(0, humanSpecies is null ? archetypes[rng.Next(archetypes.Count)] : Archetype.Human);

        var species = Enum.GetValues<Species>().Where(s => s != humanSpecies).ToList();
        rng.Shuffle(species);
        if (humanSpecies is { } pick) species.Insert(0, pick);

        var players = new PlayerState[PoMuleTuning.Seats];
        for (var seat = 0; seat < players.Length; seat++)
        {
            var goods = new int[4];
            goods[(int)Good.Food] = PoMuleTuning.StartFood;
            goods[(int)Good.Energy] = PoMuleTuning.StartEnergy;
            players[seat] = new PlayerState
            {
                Seat = seat,
                Name = archetypes[seat] == Archetype.Human ? "You"
                    : seat == 0 ? $"{archetypes[seat]} II" : archetypes[seat].ToString(),
                Species = species[seat],
                Archetype = archetypes[seat],
                Cash = PoMuleSpecies.Get(species[seat]).StartingCash,
                Goods = goods,
            };
        }

        var owner = new sbyte[map.Plots.Length];
        var installed = new sbyte[map.Plots.Length];
        Array.Fill(owner, Nobody);
        Array.Fill(installed, Nobody);
        return new MatchState { Seed = seed, Rng = rng, Map = map, Players = players, Owner = owner, Installed = installed, Assayed = new bool[map.Plots.Length] };
    }
}
