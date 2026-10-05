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
    /// <summary>Starts the shared clock, feeds everyone and sets how fast each may move.</summary>
    public static void Begin(MatchState match)
    {
        match.ClockTicks = PoMuleTuning.DevelopmentSeconds * PoMuleTuning.TicksPerSecond;
        var need = PoMuleTuning.FoodNeed(match.Month);
        foreach (var player in match.Players)
        {
            var food = player.Goods[(int)Good.Food];
            var percent = food >= need ? 100
                : food == 0 ? 0
                : Math.Max(PoMuleTuning.MinSpeedPercent, 100 * food / need);
            if (player.Species == Species.ZephyrFlapper) percent = percent * 110 / 100;

            player.SpeedPercent = percent;
            player.Goods[(int)Good.Food] = Math.Max(0, food - need);
            player.HasMule = false;
            player.Outfit = MatchState.Nobody;
            player.InPub = false;
            player.HoldsAssay = false;
        }
    }

    /// <summary>On the map, fed, and with time on the clock.</summary>
    public static bool CanAct(MatchState match, int seat)
    {
        var player = match.Players[seat];
        return match.ClockTicks > 0 && !player.InPub && player.SpeedPercent > 0;
    }

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
    /// A collision reported by the renderer. Only a dash-speed hit frightens a M.U.L.E.
    /// </summary>
    /// <returns>True when the victim's M.U.L.E. bolted.</returns>
    public static bool Bump(MatchState match, int victim, bool dashing)
    {
        var player = match.Players[victim];
        if (!dashing || !player.HasMule) return false;
        if (player.Species == Species.SpheroidDrifter && match.Rng.Chance(50)) return false;
        LoseMule(player);
        return true;
    }

    /// <summary>Cashes out for the rest of the month.</summary>
    /// <returns>Credits paid: more the earlier the colonist quits, and more in later months.</returns>
    public static int EnterPub(MatchState match, int seat)
    {
        var player = match.Players[seat];
        if (player.InPub || player.SpeedPercent == 0) return 0;

        var secondsLeft = Math.Max(0, match.ClockTicks) / PoMuleTuning.TicksPerSecond;
        var payout = Math.Min(PoMuleTuning.PubCap, secondsLeft * (3 + match.Month));
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
        match.Assayed[plot] || match.Players[seat].Species == Species.CrystiteWeaver;

    /// <summary>The clock hit zero: every M.U.L.E. still on a tether bolts.</summary>
    /// <returns>The seats that lost one.</returns>
    public static IReadOnlyList<int> End(MatchState match)
    {
        match.ClockTicks = 0;
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
