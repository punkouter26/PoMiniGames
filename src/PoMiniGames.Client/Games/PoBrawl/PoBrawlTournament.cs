using PoMiniGames.Domain.Primitives;
using PoMiniGames.Domain.Services;

namespace PoMiniGamesClient.Games.PoBrawl;

/// <summary>
/// One CPU-only, eight-fighter, single-elimination Brawl tournament: the random draw, the seven
/// bouts (four quarterfinals, two semifinals, the final), who advances where, and every
/// fighter's Elo as the results come in.
/// </summary>
/// <remarks>
/// <para>
/// The Elo arithmetic is the server's own <see cref="PairwiseEloCalculator"/> with its default
/// <see cref="PairwiseEloOptions"/> (seed 1000, K 24, floor 100), so the numbers shown here
/// move the way the global "Brawl Demo" fighter board does when the page reports each bout to
/// <c>POST /api/pobrawl/elo</c>. Starting ratings come from that board when it can be read.
/// The server stays the authority for the board: this copy is what the bracket shows.
/// </para>
/// <para>
/// A bout is never a draw. The engine breaks a level bell in tournament mode
/// (game.js <c>_tournamentDecision</c>), because a knockout bracket cannot advance two fighters.
/// </para>
/// </remarks>
public sealed class PoBrawlTournament
{
    /// <summary>Fighters in the draw.</summary>
    public const int Size = 8;

    private static readonly PairwiseEloCalculator Elo = new(new PairwiseEloOptions());

    /// <summary>Rating for a fighter the board has never seen.</summary>
    public static int SeedElo => Elo.SeedElo;

    private readonly Dictionary<string, int> _startElo;
    private readonly Dictionary<string, int> _elo;
    private readonly Dictionary<string, (int Wins, int Losses)> _record = [];

    /// <summary>The draw, in bracket order: entries 0 v 1, 2 v 3, 4 v 5, 6 v 7 open the quarterfinals.</summary>
    public IReadOnlyList<PoBrawlFighter> Field { get; }

    /// <summary>All seven bouts in play order: quarterfinals 0-3, semifinals 4-5, the final 6.</summary>
    public IReadOnlyList<Bout> Bouts { get; }

    private PoBrawlTournament(IReadOnlyList<PoBrawlFighter> field, IReadOnlyDictionary<string, int> ratings)
    {
        Field = field;
        _startElo = field.ToDictionary(f => f.Id, f => ratings.TryGetValue(f.Id, out var r) ? r : SeedElo);
        _elo = new Dictionary<string, int>(_startElo);
        foreach (var f in field) _record[f.Id] = (0, 0);

        var bouts = new List<Bout>(Size - 1);
        for (var i = 0; i < Size / 2; i++) bouts.Add(new Bout(i, Round.Quarterfinal, i, field[i * 2].Id, field[i * 2 + 1].Id));
        bouts.Add(new Bout(4, Round.Semifinal, 0, null, null));
        bouts.Add(new Bout(5, Round.Semifinal, 1, null, null));
        bouts.Add(new Bout(6, Round.Final, 0, null, null));
        Bouts = bouts;
    }

    /// <summary>
    /// Draw <see cref="Size"/> distinct fighters from <paramref name="roster"/> at random and
    /// place them at random. <paramref name="ratings"/> maps fighter id to a starting rating;
    /// anyone missing starts at <see cref="SeedElo"/>.
    /// </summary>
    public static PoBrawlTournament Draw(IReadOnlyList<PoBrawlFighter> roster, Random rng, IReadOnlyDictionary<string, int>? ratings = null)
    {
        ArgumentNullException.ThrowIfNull(roster);
        ArgumentNullException.ThrowIfNull(rng);
        var distinct = roster.DistinctBy(f => f.Id).ToArray();
        if (distinct.Length < Size)
            throw new ArgumentException($"A tournament needs {Size} distinct fighters; the roster has {distinct.Length}.", nameof(roster));
        rng.Shuffle(distinct);
        return new PoBrawlTournament(distinct[..Size], ratings ?? new Dictionary<string, int>());
    }

    /// <summary>The next bout to fight, or null once the final is decided.</summary>
    public Bout? Current => Bouts.FirstOrDefault(b => b.WinnerId is null);

    /// <summary>The champion, once the final is decided.</summary>
    public string? ChampionId => Bouts[^1].WinnerId;

    public bool IsComplete => ChampionId is not null;

    public int EloOf(string fighterId) => _elo.TryGetValue(fighterId, out var r) ? r : SeedElo;

    public int StartEloOf(string fighterId) => _startElo.TryGetValue(fighterId, out var r) ? r : SeedElo;

    public (int Wins, int Losses) RecordOf(string fighterId) => _record.TryGetValue(fighterId, out var r) ? r : (0, 0);

    /// <summary>Everyone in the draw, best rating now first: the closing standings.</summary>
    public IReadOnlyList<PoBrawlFighter> Standings =>
        [.. Field.OrderByDescending(f => f.Id == ChampionId)
                 .ThenByDescending(f => RecordOf(f.Id).Wins)
                 .ThenByDescending(f => EloOf(f.Id))];

    /// <summary>
    /// Record the result of <see cref="Current"/>: <paramref name="winnerSide"/> 1 is the bout's
    /// left corner (<see cref="Bout.P1Id"/>), 2 the right. Prices both fighters' Elo, then sends
    /// the winner on to their slot in the next round. Returns the bout it decided.
    /// </summary>
    public Bout RecordResult(int winnerSide, double elapsedSeconds, bool knockout)
    {
        if (winnerSide is not (1 or 2))
            throw new ArgumentOutOfRangeException(nameof(winnerSide), winnerSide, "A tournament bout has a winner: side 1 or 2.");
        var bout = Current ?? throw new InvalidOperationException("The tournament is already decided.");
        if (bout.P1Id is null || bout.P2Id is null)
            throw new InvalidOperationException($"Bout {bout.Index} has no pairing yet.");

        var (winner, loser) = winnerSide == 1 ? (bout.P1Id, bout.P2Id) : (bout.P2Id, bout.P1Id);
        var delta = Elo.Delta(_elo[winner], _elo[loser], isDraw: false);
        var winnerBefore = _elo[winner];
        var loserBefore = _elo[loser];
        _elo[winner] = Elo.ApplyDelta(winnerBefore, delta);
        _elo[loser] = Elo.ApplyDelta(loserBefore, -delta);
        _record[winner] = (_record[winner].Wins + 1, _record[winner].Losses);
        _record[loser] = (_record[loser].Wins, _record[loser].Losses + 1);

        bout.WinnerId = winner;
        bout.ElapsedSeconds = elapsedSeconds;
        bout.Knockout = knockout;
        bout.P1Delta = winnerSide == 1 ? _elo[winner] - winnerBefore : _elo[loser] - loserBefore;
        bout.P2Delta = winnerSide == 2 ? _elo[winner] - winnerBefore : _elo[loser] - loserBefore;

        // Quarterfinal i feeds semifinal i / 2; semifinal j feeds the final. An even slot is the
        // next bout's left corner, an odd one its right.
        if (bout.Round != Round.Final)
        {
            var next = Bouts[bout.Round == Round.Quarterfinal ? 4 + bout.Slot / 2 : 6];
            if (bout.Slot % 2 == 0) next.P1Id = winner; else next.P2Id = winner;
        }
        return bout;
    }

    public enum Round { Quarterfinal, Semifinal, Final }

    /// <summary>How many bouts a round holds.</summary>
    public static int BoutsIn(Round round) => round switch
    {
        Round.Quarterfinal => 4,
        Round.Semifinal => 2,
        _ => 1,
    };

    /// <summary>One bout of the bracket. Pairings fill in as the earlier round finishes.</summary>
    /// <param name="Index">0-6, play order.</param>
    /// <param name="Slot">Position inside its round, 0-based.</param>
    public sealed record Bout(int Index, Round Round, int Slot, string? P1Id, string? P2Id)
    {
        public string? P1Id { get; set; } = P1Id;
        public string? P2Id { get; set; } = P2Id;
        public string? WinnerId { get; set; }
        public double ElapsedSeconds { get; set; }
        public bool Knockout { get; set; }
        /// <summary>Elo the left corner gained (+) or lost (−) in this bout.</summary>
        public int P1Delta { get; set; }
        public int P2Delta { get; set; }

        /// <summary>"Quarterfinal 2 of 4", "Semifinal 1 of 2", "Final".</summary>
        public string Label => Round == Round.Final ? "Final" : $"{Round} {Slot + 1} of {BoutsIn(Round)}";

        public string? LoserId => WinnerId is null ? null : WinnerId == P1Id ? P2Id : P1Id;
    }
}
