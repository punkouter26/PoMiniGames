namespace PoMiniGames.Shared.Games.PoMule;

public sealed record Standing(int Rank, int Seat, string Name, int NetWorth);

public static class PoMuleScoring
{
    /// <summary>Cash + land + installed M.U.L.E.s + goods at today's Store prices.</summary>
    public static int NetWorth(MatchState match, int seat)
    {
        var player = match.Players[seat];
        var worth = player.Cash;
        for (var i = 0; i < match.Owner.Length; i++)
        {
            if (match.Owner[i] != seat) continue;
            worth += PoMuleTuning.LandValue;
            if (match.Installed[i] != MatchState.Nobody) worth += PoMuleTuning.MuleValue;
        }
        for (var g = 0; g < player.Goods.Length; g++)
            worth += player.Goods[g] * match.Store.Price[g];
        return worth;
    }

    /// <summary>Richest first; ties go to the lower seat.</summary>
    public static IReadOnlyList<Standing> Standings(MatchState match) =>
        [.. match.Players
            .Select(p => (p.Seat, p.Name, Worth: NetWorth(match, p.Seat)))
            .OrderByDescending(p => p.Worth).ThenBy(p => p.Seat)
            .Select((p, i) => new Standing(i + 1, p.Seat, p.Name, p.Worth))];

    /// <summary>
    /// Who is losing among <paramref name="seats"/>. The original breaks every tie (a contested
    /// plot, two equal bids) in favour of the colonist furthest behind.
    /// </summary>
    public static int Trailing(MatchState match, IEnumerable<int> seats) =>
        seats.MinBy(seat => (NetWorth(match, seat), -seat));

    /// <summary>
    /// The colony grade. Individual greed can sink everyone: enough combined wealth and not
    /// too many months of colony-wide shortage, or the winner's title is hollow.
    /// </summary>
    public static bool ColonySurvives(int combinedNetWorth, int crisisMonths) =>
        combinedNetWorth >= PoMuleTuning.FederationTarget && crisisMonths <= PoMuleTuning.MaxCrisisMonths;
}
