namespace PoMiniGames.Shared.Games.PoMule;

/// <summary>What the engine answers when a colonist tries to do something.</summary>
public enum Outcome : byte { Ok, NoCash, SoldOut, NotAllowed, Runaway }

/// <summary>
/// The development phase. The renderer moves the avatars and tells the engine what they
/// reached; every method here checks that claim against the match before changing anything,
/// so cash and stock can never go negative whatever the renderer reports.
/// </summary>
public static class PoMuleDevelopment
{
    /// <summary>
    /// Starts the shared clock and sets how much of it each one gets from the Food they hold.
    /// The Food itself is eaten over the month (see <see cref="End"/>), so the status line
    /// does not show a fed colony at zero.
    /// </summary>
    public static void Begin(MatchState match)
    {
        match.ClockTicks = PoMuleTuning.DevelopmentSeconds * PoMuleTuning.TicksPerSecond;
        match.BumpRunaways = 0;
        var need = PoMuleTuning.FoodNeed(match.Month);
        foreach (var player in match.Players)
        {
            var food = player.Goods[(int)Good.Food];
            // Hunger costs time, not pace: a short month, as in the original.
            player.TimePercent = food >= need ? 100 : Math.Max(PoMuleTuning.MinTimePercent, 100 * food / need);
            player.WentShort = food < need;
            player.HasMule = false;
            player.Outfit = MatchState.Nobody;
            player.InPub = false;
            player.HoldsAssay = false;
            player.Spooked = false;
        }
    }

    /// <summary>Ticks this colonist has left: the shared clock, less what hunger took off the end.</summary>
    public static int TimeLeft(MatchState match, int seat)
    {
        var month = PoMuleTuning.DevelopmentSeconds * PoMuleTuning.TicksPerSecond;
        return Math.Max(0, match.ClockTicks - month * (100 - match.Players[seat].TimePercent) / 100);
    }

    /// <summary>Walking pace, 100 being normal.</summary>
    public static int Speed(MatchState match, int seat) => match.Has(match.Players[seat], Species.ZephyrFlapper) ? 110 : 100;

    /// <summary>On the map with time on their clock.</summary>
    public static bool CanAct(MatchState match, int seat) => TimeLeft(match, seat) > 0 && !match.Players[seat].InPub;

    public static Outcome BuyMule(MatchState match, int seat)
    {
        var player = match.Players[seat];
        if (!CanAct(match, seat) || player.HasMule) return Outcome.NotAllowed;
        if (match.Store.Mules == 0) return Outcome.SoldOut;
        if (player.Cash < match.Store.MulePrice) return Outcome.NoCash;

        player.Cash -= match.Store.MulePrice;
        match.Store.Mules--;
        player.HasMule = true;
        player.Outfit = MatchState.Nobody;
        return Outcome.Ok;
    }

    public static Outcome Outfit(MatchState match, int seat, Good good)
    {
        var player = match.Players[seat];
        if (!CanAct(match, seat) || !player.HasMule) return Outcome.NotAllowed;
        if (player.Outfit == (sbyte)good) return Outcome.Ok; // already wearing it: nothing to pay for
        var cost = PoMuleTuning.OutfitCost[(int)good];
        if (player.Cash < cost) return Outcome.NoCash;

        player.Cash -= cost;
        player.Outfit = (sbyte)good;
        return Outcome.Ok;
    }

    /// <summary>
    /// Installs the towed M.U.L.E. On a plot that already has one, the two swap and the old
    /// one comes back out on the tether. On land the colonist does not own, it bolts.
    /// </summary>
    public static Outcome Install(MatchState match, int seat, int plot)
    {
        var player = match.Players[seat];
        if (!CanAct(match, seat) || !player.HasMule) return Outcome.NotAllowed;
        if (match.Owner[plot] != seat)
        {
            LoseMule(player);
            return Outcome.Runaway;
        }
        if (player.Outfit == MatchState.Nobody) return Outcome.NotAllowed;

        var previous = match.Installed[plot];
        match.Installed[plot] = player.Outfit;
        if (previous == MatchState.Nobody) LoseMule(player);
        else player.Outfit = previous;
        return Outcome.Ok;
    }

    /// <summary>
    /// A collision reported by the renderer. Only a dash-speed hit frightens a M.U.L.E., and
    /// nobody loses a second one to a bump in the same month: the original had no such loss
    /// at all, so here it stays an upset rather than a way to empty the corral.
    /// </summary>
    /// <returns>True when the victim's M.U.L.E. bolted.</returns>
    public static bool Bump(MatchState match, int victim, bool dashing)
    {
        var player = match.Players[victim];
        if (!dashing || !player.HasMule || player.Spooked) return false;
        if (match.Has(player, Species.SpheroidDrifter) && match.Rng.Chance(50)) return false;
        LoseMule(player);
        player.Spooked = true;
        match.BumpRunaways++;
        return true;
    }

    /// <summary>What the Pub would pay a colonist who walked in right now.</summary>
    public static int PubPayout(MatchState match, int seat) => Math.Min(
        PoMuleTuning.PubCap,
        TimeLeft(match, seat) / PoMuleTuning.TicksPerSecond * (3 + match.Month));

    /// <summary>Cashes out for the rest of the month.</summary>
    /// <returns>Credits paid: more the earlier the colonist quits, and more in later months.</returns>
    public static int EnterPub(MatchState match, int seat)
    {
        var player = match.Players[seat];
        if (player.InPub) return 0;

        var payout = PubPayout(match, seat);
        player.Cash += payout;
        player.InPub = true;
        LoseMule(player); // a M.U.L.E. left outside the pub wanders off
        return payout;
    }

    public static Outcome VisitAssayOffice(MatchState match, int seat)
    {
        if (!CanAct(match, seat)) return Outcome.NotAllowed;
        match.Players[seat].HoldsAssay = true;
        return Outcome.Ok;
    }

    /// <summary>Spends the assay picked up at the office on one plot. The result is public.</summary>
    public static Outcome Survey(MatchState match, int seat, int plot)
    {
        var player = match.Players[seat];
        if (!CanAct(match, seat) || !player.HoldsAssay) return Outcome.NotAllowed;
        player.HoldsAssay = false;
        match.Assayed[plot] = true;
        return Outcome.Ok;
    }

    public static bool CanSeeCrystite(MatchState match, int seat, int plot) =>
        match.Assayed[plot] || match.Has(match.Players[seat], Species.CrystiteWeaver);

    /// <summary>The clock hit zero: the month's Food is eaten and every M.U.L.E. still on a tether bolts.</summary>
    /// <returns>The seats that lost one.</returns>
    public static IReadOnlyList<int> End(MatchState match)
    {
        match.ClockTicks = 0;
        var need = PoMuleTuning.FoodNeed(match.Month);
        foreach (var player in match.Players)
            player.Goods[(int)Good.Food] = Math.Max(0, player.Goods[(int)Good.Food] - need);
        var lost = new List<int>();
        foreach (var player in match.Players.Where(p => p.HasMule))
        {
            LoseMule(player);
            lost.Add(player.Seat);
        }
        return lost;
    }

    private static void LoseMule(PlayerState player)
    {
        player.HasMule = false;
        player.Outfit = MatchState.Nobody;
    }
}
