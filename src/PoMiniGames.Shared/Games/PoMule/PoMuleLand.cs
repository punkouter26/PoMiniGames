namespace PoMiniGames.Shared.Games.PoMule;

/// <summary>Who gets which plot: the simultaneous monthly grant and the even-month auction.</summary>
public static class PoMuleLand
{
    public static bool Claimable(MatchState match, int plot) =>
        match.Owner[plot] == MatchState.Nobody && match.Map.Plots[plot].Terrain != Terrain.Town;

    /// <summary>
    /// Resolves all eight cursors at once.
    /// </summary>
    /// <param name="picks">Plot index per seat, or -1 for "picked nothing".</param>
    /// <returns>The plot each seat received, or -1.</returns>
    public static int[] Grant(MatchState match, IReadOnlyList<int> picks)
    {
        var awarded = new int[picks.Count];
        Array.Fill(awarded, -1);
        var displaced = new List<int>();

        foreach (var group in Enumerable.Range(0, picks.Count).Where(s => picks[s] >= 0).GroupBy(s => picks[s]))
        {
            var claimants = group.ToList();
            if (Claimable(match, group.Key))
            {
                var winner = claimants[match.Rng.Next(claimants.Count)];
                claimants.Remove(winner);
                Give(match, winner, group.Key, awarded);
            }
            displaced.AddRange(claimants);
        }

        // Losers settle after every winner, lowest seat first, each on the nearest plot still free.
        foreach (var seat in displaced.Order())
        {
            var plot = NearestFree(match, picks[seat]);
            if (plot >= 0) Give(match, seat, plot, awarded);
        }
        return awarded;
    }

    /// <summary>
    /// The closest claimable plot to <paramref name="from"/>, searching outward ring by ring
    /// and around the seam, or -1 when the planet is full.
    /// </summary>
    public static int NearestFree(MatchState match, int from)
    {
        var (fromColumn, fromRow) = (from % PoMuleMap.Columns, from / PoMuleMap.Columns);
        var best = -1;
        var bestKey = int.MaxValue;
        for (var i = 0; i < match.Owner.Length; i++)
        {
            if (!Claimable(match, i)) continue;
            var dc = PoMuleMap.ColumnDistance(i % PoMuleMap.Columns, fromColumn);
            var dr = Math.Abs(i / PoMuleMap.Columns - fromRow);
            // Ring first, then straight-line neighbours before diagonals; index breaks ties.
            var key = Math.Max(dc, dr) * 100 + dc + dr;
            if (key < bestKey) (best, bestKey) = (i, key);
        }
        return best;
    }

    private static void Give(MatchState match, int seat, int plot, int[] awarded)
    {
        match.Owner[plot] = (sbyte)seat;
        awarded[seat] = plot;
    }

    public static bool IsAuctionMonth(int month) => month % 2 == 0;

    /// <summary>Up to two random free plots for this month's auction block.</summary>
    public static int[] PickAuctionPlots(MatchState match)
    {
        var free = Enumerable.Range(0, match.Owner.Length).Where(i => Claimable(match, i)).ToList();
        match.Rng.Shuffle(free);
        return [.. free.Take(PoMuleTuning.AuctionPlotsPerEvenMonth)];
    }

    public static void OpenAuction(MatchState match, int plot)
    {
        match.AuctionPlot = plot;
        match.HighBid = 0;
        match.HighBidder = MatchState.Nobody;
    }

    /// <summary>The smallest bid the block will take right now.</summary>
    public static int NextBid(MatchState match) =>
        Math.Max(PoMuleTuning.AuctionOpeningBid, match.HighBid + PoMuleTuning.AuctionRaise);

    /// <summary>
    /// An open ascending bid. Refused unless it beats the standing bid, the seat can pay it,
    /// and the seat is not already the high bidder.
    /// </summary>
    public static bool Bid(MatchState match, int seat, int amount)
    {
        if (match.AuctionPlot < 0 || match.HighBidder == seat || amount < PoMuleTuning.AuctionOpeningBid) return false;
        if (amount <= match.HighBid || amount > match.Players[seat].Cash) return false;
        match.HighBid = amount;
        match.HighBidder = (sbyte)seat;
        return true;
    }

    /// <returns>The winning seat, or -1 when nobody bid.</returns>
    public static int CloseAuction(MatchState match)
    {
        var winner = match.HighBidder;
        if (winner != MatchState.Nobody)
        {
            match.Players[winner].Cash -= match.HighBid;
            match.Owner[match.AuctionPlot] = winner;
        }
        match.AuctionPlot = -1;
        return winner;
    }
}
