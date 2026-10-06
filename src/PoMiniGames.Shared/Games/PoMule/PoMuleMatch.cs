namespace PoMiniGames.Shared.Games.PoMule;

public enum NoticeKind : byte { LandGranted, AuctionOpened, AuctionWon, MuleRanAway, PubVisit, Traded, ColonyEvent, MonthEnded, Luck, WampusCaught }

/// <summary>Something that just happened, for the page to announce. <c>A</c> and <c>B</c> depend on the kind.</summary>
public readonly record struct Notice(NoticeKind Kind, int Seat, int A = 0, int B = 0);

/// <summary>
/// Drives a match through its months and phases, one tick (a tenth of a second) at a time.
/// </summary>
/// <remarks>
/// The match has no clock of its own: whoever owns it calls <see cref="Advance"/>. In the
/// browser that is the renderer's frame loop, which also moves the avatars and reports where
/// they got to (<see cref="Arrive"/>, <see cref="Bump"/>). With <see cref="Headless"/> set,
/// AI colonists instead "travel" for a fixed number of ticks per errand, so a whole match can
/// run with no renderer at all — that is what the tests and the balance check use.
/// </remarks>
public sealed class PoMuleMatch(MatchState state)
{
    // Headless travel time per errand, in ticks at full speed.
    private const int TownTrip = 50;
    private const int PlotTrip = 40;
    private const int PubTrip = 30;
    private const int AuctionQuietTicks = 50;
    private const int ShortPhaseTicks = 10;

    private readonly int[] _busy = new int[PoMuleTuning.Seats];
    private readonly Goal?[] _errand = new Goal?[PoMuleTuning.Seats];
    private readonly Queue<int> _auctionBlock = new();
    private bool _begun;
    private int _quiet;
    private readonly bool[] _claimed = new bool[PoMuleTuning.Seats];
    private int _landPrev = -1;
    private int _landWait;
    private bool _wampusCaught;

    public MatchState State { get; } = state;

    /// <summary>AI errands take a fixed time instead of waiting for the renderer to report arrivals.</summary>
    public bool Headless { get; init; }

    /// <summary>Demo pacing: the production, event and standings screens last one second.</summary>
    public bool Fast { get; init; }

    /// <summary>Seat 0's direction on the trading floor: +1 up, -1 down, 0 still.</summary>
    public int HumanMarketInput { get; set; }

    /// <summary>What happened during the last <see cref="Advance"/> call.</summary>
    public List<Notice> Notices { get; } = [];

    /// <summary>The last production run, for the renderer to animate. Null before the first.</summary>
    public ProductionReport? Report { get; private set; }

    /// <summary>Where each AI colonist is heading (development phase only).</summary>
    public Goal[] Goals { get; } = new Goal[PoMuleTuning.Seats];

    public static PoMuleMatch New(ulong seed, Species? humanSpecies, bool headless = false, bool fast = false) =>
        new(MatchState.New(seed, humanSpecies)) { Headless = headless, Fast = fast };

    /// <summary>Plays an all-AI match from start to finish with no renderer.</summary>
    public static PoMuleMatch RunToEnd(ulong seed, Species? humanSpecies = null)
    {
        var match = New(seed, humanSpecies, headless: true, fast: true);
        while (match.State.Phase != Phase.Finished) match.Advance(1000);
        return match;
    }

    private bool IsAi(int seat) => State.Players[seat].Archetype != Archetype.Human;

    /// <summary>
    /// Runs up to <paramref name="ticks"/> ticks. Stops early at the start of a new month so
    /// the caller can save exactly there.
    /// </summary>
    /// <returns>True when a new month has just begun (or the match has just finished).</returns>
    public bool Advance(int ticks)
    {
        Notices.Clear();
        for (var i = 0; i < ticks && State.Phase != Phase.Finished; i++)
        {
            var month = State.Month;
            Step();
            if (State.Month != month || State.Phase == Phase.Finished) return true;
        }
        return false;
    }

    private void Go(Phase phase)
    {
        State.Phase = phase;
        _begun = false;
    }

    private void Step()
    {
        if (!_begun)
        {
            _begun = true;
            var phase = State.Phase;
            Begin();
            if (State.Phase != phase) return; // nothing to do in that phase; it moved on
        }

        switch (State.Phase)
        {
            case Phase.Land: StepLand(); break;
            case Phase.Auction: StepAuction(); break;
            case Phase.Development: StepDevelopment(); break;
            case Phase.Production:
                if (--State.ClockTicks <= 0) Go(Phase.Event);
                break;
            case Phase.Event:
                if (--State.ClockTicks <= 0) Go(Phase.Market);
                break;
            case Phase.Market: StepMarket(); break;
            case Phase.Standings:
                if (--State.ClockTicks > 0) break;
                Notices.Add(new Notice(NoticeKind.MonthEnded, -1, State.Month));
                if (State.Month >= PoMuleTuning.Months) Go(Phase.Finished);
                else
                {
                    State.Month++;
                    Go(Phase.Land);
                }
                break;
        }
    }

    private int Display(int seconds) => Fast ? ShortPhaseTicks : seconds * PoMuleTuning.TicksPerSecond;

    private void Begin()
    {
        switch (State.Phase)
        {
            case Phase.Land:
                if (!Enumerable.Range(0, State.Owner.Length).Any(i => PoMuleLand.Claimable(State, i)))
                {
                    Go(Phase.Development);
                    break;
                }
                Array.Clear(_claimed);
                _landPrev = -1;
                _landWait = PoMuleTuning.LandStepTicks;
                State.LandCursor = NextClaimable(-1);
                for (var seat = 0; seat < State.LandPicks.Length; seat++)
                    State.LandPicks[seat] = IsAi(seat) ? PoMuleAi.PickLand(State, seat) : -1;
                break;

            case Phase.Auction:
                _auctionBlock.Clear();
                foreach (var plot in PoMuleLand.PickAuctionPlots(State)) _auctionBlock.Enqueue(plot);
                if (!OpenNextAuction()) Go(Phase.Development);
                break;

            case Phase.Development:
                PoMuleDevelopment.Begin(State);
                State.WampusPlot = -1;
                _wampusCaught = false;
                Array.Clear(_busy);
                Array.Clear(_errand);
                break;

            case Phase.Production:
                State.LastEvent = PoMuleEvents.Roll(State.Rng);
                Report = PoMuleProduction.Run(State, State.LastEvent);
                PoMuleEvents.Aftermath(State, State.LastEvent);
                State.ClockTicks = Display(PoMuleTuning.ProductionSeconds);
                break;

            case Phase.Event:
                Notices.Add(new Notice(NoticeKind.ColonyEvent, -1, (int)State.LastEvent, State.MeteorPlot));
                var (lucky, credits) = PoMuleEvents.Luck(State);
                Notices.Add(new Notice(NoticeKind.Luck, lucky, credits));
                State.ClockTicks = Display(PoMuleTuning.EventSeconds);
                break;

            case Phase.Market:
                HumanMarketInput = 0; // a key held when last month's market closed must not walk this one
                PoMuleMarket.Open(State, Good.Food);
                break;

            case Phase.Standings:
                State.History.Add([.. State.Players.Select(p => PoMuleScoring.NetWorth(State, p.Seat))]);
                State.ClockTicks = Display(PoMuleTuning.StandingsSeconds);
                break;
        }
    }

    // ── Land grant ──

    /// <summary>True once this seat has its plot for the month.</summary>
    public bool HasClaimed(int seat) => _claimed[seat];

    private int NextClaimable(int after)
    {
        for (var i = after + 1; i < State.Owner.Length; i++)
            if (PoMuleLand.Claimable(State, i)) return i;
        return -1;
    }

    /// <summary>
    /// The land grant, as on the Atari: one highlighter sweeps the free plots from the top
    /// left to the bottom right, a row at a time, and a colonist takes the plot it is on by
    /// pressing the button. Everyone watches the same highlighter; if several press on the
    /// same plot, one wins it and the others get the nearest free plot.
    /// </summary>
    private void StepLand()
    {
        var cursor = State.LandCursor;
        var picks = new int[State.Players.Length];
        Array.Fill(picks, -1);
        for (var seat = 0; seat < picks.Length; seat++)
        {
            if (_claimed[seat]) continue;
            var want = State.LandPicks[seat];
            if (IsAi(seat))
            {
                // An AI waits for the plot it chose; if that went to someone else, or the
                // highlighter has passed it, it settles on the best plot still to come.
                if (want >= 0 && (want < cursor || !PoMuleLand.Claimable(State, want)))
                    State.LandPicks[seat] = want = PoMuleAi.PickLand(State, seat, from: cursor);
                if (want == cursor) picks[seat] = cursor;
            }
            else
            {
                // The player's press names the plot they saw lit. One step of grace: the
                // screen is a tick or two behind the highlighter.
                if (want >= 0 && (want == cursor || want == _landPrev) && PoMuleLand.Claimable(State, want)) picks[seat] = want;
                State.LandPicks[seat] = -1;
            }
        }

        if (picks.Any(p => p >= 0))
        {
            var awarded = PoMuleLand.Grant(State, picks);
            for (var seat = 0; seat < awarded.Length; seat++)
            {
                if (awarded[seat] < 0) continue;
                _claimed[seat] = true;
                Notices.Add(new Notice(NoticeKind.LandGranted, seat, awarded[seat]));
            }
        }

        if (--_landWait <= 0)
        {
            _landWait = PoMuleTuning.LandStepTicks;
            _landPrev = cursor;
            State.LandCursor = NextClaimable(cursor);
        }
        State.ClockTicks = Enumerable.Range(Math.Max(0, State.LandCursor), State.Owner.Length - Math.Max(0, State.LandCursor))
            .Count(i => PoMuleLand.Claimable(State, i)) * PoMuleTuning.LandStepTicks;

        if (State.LandCursor >= 0 && !_claimed.All(c => c)) return;
        State.LandCursor = -1;
        Array.Fill(State.LandPicks, -1);
        Go(PoMuleLand.IsAuctionMonth(State.Month) ? Phase.Auction : Phase.Development);
    }

    // ── Auction ──

    private bool OpenNextAuction()
    {
        if (!_auctionBlock.TryDequeue(out var plot)) return false;
        PoMuleLand.OpenAuction(State, plot);
        State.ClockTicks = PoMuleTuning.AuctionSeconds * PoMuleTuning.TicksPerSecond;
        _quiet = 0;
        Notices.Add(new Notice(NoticeKind.AuctionOpened, -1, plot));
        return true;
    }

    /// <summary>Seat 0 raises the standing bid by one step. False when it cannot.</summary>
    public bool HumanBid()
    {
        if (State.Phase != Phase.Auction || State.AuctionPlot < 0) return false;
        if (!PoMuleLand.Bid(State, 0, PoMuleLand.NextBid(State))) return false;
        _quiet = 0;
        return true;
    }

    private void StepAuction()
    {
        State.ClockTicks--;
        _quiet++;
        for (var seat = 0; seat < State.Players.Length; seat++)
        {
            // About one look at the block per second each, so bids arrive at a human pace.
            if (!IsAi(seat) || !State.Rng.Chance(10)) continue;
            var bid = PoMuleAi.AuctionBid(State, seat);
            if (bid > 0 && PoMuleLand.Bid(State, seat, bid)) _quiet = 0;
        }

        if (State.ClockTicks > 0 && _quiet < AuctionQuietTicks) return;
        var plot = State.AuctionPlot;
        var price = State.HighBid;
        var winner = PoMuleLand.CloseAuction(State);
        if (winner >= 0) Notices.Add(new Notice(NoticeKind.AuctionWon, winner, plot, price));
        if (!OpenNextAuction()) Go(Phase.Development);
    }

    // ── Development ──

    private void StepDevelopment()
    {
        State.ClockTicks--;
        StepWampus();
        for (var seat = 0; seat < State.Players.Length; seat++)
        {
            if (!IsAi(seat)) continue;
            if (!PoMuleDevelopment.CanAct(State, seat))
            {
                Goals[seat] = new Goal(GoalKind.Idle, -1, default);
                continue;
            }
            if (!Headless)
            {
                Goals[seat] = PoMuleAi.NextGoal(State, seat);
                continue;
            }

            if (_busy[seat] > 0)
            {
                _busy[seat]--;
                continue;
            }
            if (_errand[seat] is { } done) Perform(seat, done);
            if (!PoMuleDevelopment.CanAct(State, seat)) continue;
            var next = PoMuleAi.NextGoal(State, seat);
            Goals[seat] = next;
            _errand[seat] = next;
            var trip = next.Kind switch
            {
                GoalKind.Outfitter or GoalKind.Assay => TownTrip,
                GoalKind.Pub => PubTrip,
                _ => PlotTrip,
            };
            _busy[seat] = trip * 100 / State.Players[seat].SpeedPercent;
        }

        var anyoneOut = Enumerable.Range(0, State.Players.Length).Any(seat => PoMuleDevelopment.CanAct(State, seat));
        if (State.ClockTicks > 0 && anyoneOut) return;
        foreach (var seat in PoMuleDevelopment.End(State))
            Notices.Add(new Notice(NoticeKind.MuleRanAway, seat));
        State.WampusPlot = -1;
        Go(Phase.Production);
    }

    /// <summary>
    /// The wampus: it shows itself on a mountain for a few seconds in every ten, somewhere
    /// new each time, until someone catches it or the month ends.
    /// </summary>
    private void StepWampus()
    {
        if (_wampusCaught) return;
        var beat = (PoMuleTuning.DevelopmentSeconds * PoMuleTuning.TicksPerSecond - State.ClockTicks) % PoMuleTuning.WampusCycleTicks;
        if (beat == PoMuleTuning.WampusCycleTicks - PoMuleTuning.WampusVisibleTicks)
        {
            var mountains = Enumerable.Range(0, State.Owner.Length).Where(i => State.Map.Plots[i].Terrain == Terrain.Mountain).ToList();
            State.WampusPlot = mountains.Count == 0 ? -1 : mountains[State.Rng.Next(mountains.Count)];
        }
        else if (beat == 0) State.WampusPlot = -1;
    }

    /// <summary>A colonist reaches the wampus while it is showing. Returns the bounty paid, or 0.</summary>
    public int CatchWampus(int seat)
    {
        if (State.Phase != Phase.Development || State.WampusPlot < 0 || _wampusCaught) return 0;
        if (!PoMuleDevelopment.CanAct(State, seat)) return 0;
        var bounty = PoMuleTuning.WampusBounty(State.Month);
        State.Players[seat].Cash += bounty;
        State.WampusPlot = -1;
        _wampusCaught = true;
        Notices.Add(new Notice(NoticeKind.WampusCaught, seat, bounty));
        return bounty;
    }

    /// <summary>The renderer reports that an AI colonist reached where it was heading.</summary>
    public void Arrive(int seat)
    {
        if (State.Phase == Phase.Development && IsAi(seat) && PoMuleDevelopment.CanAct(State, seat))
            Perform(seat, PoMuleAi.NextGoal(State, seat));
    }

    /// <summary>The renderer reports a collision. True when the victim's M.U.L.E. bolted.</summary>
    public bool Bump(int victim, bool dashing)
    {
        if (State.Phase != Phase.Development || !PoMuleDevelopment.Bump(State, victim, dashing)) return false;
        Notices.Add(new Notice(NoticeKind.MuleRanAway, victim));
        return true;
    }

    /// <summary>Seat 0 walks into the Pub.</summary>
    public int HumanPub()
    {
        if (State.Phase != Phase.Development) return 0;
        var payout = PoMuleDevelopment.EnterPub(State, 0);
        Notices.Add(new Notice(NoticeKind.PubVisit, 0, payout));
        return payout;
    }

    private void Perform(int seat, Goal goal)
    {
        var player = State.Players[seat];
        switch (goal.Kind)
        {
            case GoalKind.Outfitter:
                if (!player.HasMule) PoMuleDevelopment.BuyMule(State, seat);
                if (player.HasMule) PoMuleDevelopment.Outfit(State, seat, goal.Good);
                break;
            case GoalKind.Install:
                if (PoMuleDevelopment.Install(State, seat, goal.Target) == Outcome.Runaway)
                    Notices.Add(new Notice(NoticeKind.MuleRanAway, seat));
                break;
            case GoalKind.Assay:
                PoMuleDevelopment.VisitAssayOffice(State, seat);
                break;
            case GoalKind.Survey:
                PoMuleDevelopment.Survey(State, seat, goal.Target);
                break;
            case GoalKind.Pub:
                Notices.Add(new Notice(NoticeKind.PubVisit, seat, PoMuleDevelopment.EnterPub(State, seat)));
                break;
            case GoalKind.Chase:
                // With no renderer there is no collision to report, so a chase lands sometimes.
                if (Headless && goal.Target >= 0 && State.Rng.Chance(40)) Bump(goal.Target, dashing: true);
                break;
        }
    }

    // ── Market ──

    private void StepMarket()
    {
        var inputs = new int[State.Players.Length];
        for (var seat = 0; seat < inputs.Length; seat++)
            inputs[seat] = IsAi(seat) ? PoMuleAi.MarketInput(State, seat) : HumanMarketInput;
        foreach (var trade in PoMuleMarket.Tick(State, inputs))
            Notices.Add(new Notice(NoticeKind.Traded, trade.Seller, trade.Buyer, trade.Price));

        // With no human at the table, an empty floor closes at once.
        var empty = State.Players.All(p => p.Archetype != Archetype.Human) && State.LaneRole.All(r => r == 0);
        if (State.ClockTicks > 0 && !empty) return;

        var good = (Good)State.MarketGood;
        PoMuleMarket.Close(State);
        if (good != Good.Crystite)
        {
            PoMuleMarket.Open(State, good + 1);
            return;
        }
        PoMuleMarket.EndOfMonth(State);
        Go(Phase.Standings);
    }

    // ── Renderer feed ──

    public const int SnapshotHeader = 22;
    public const int SnapshotPerSeat = 15;

    /// <summary>
    /// Everything the renderer and HUD need each tick, as one flat array (one interop
    /// transfer). Header: month, phase, clock ticks, market good, auction plot, high bid, high
    /// bidder, last event, market floor price, Store M.U.L.E.s, land highlighter, Store stock ×4,
    /// Store prices ×4, M.U.L.E. price, wampus plot, crisis months. Then per seat: cash, the four
    /// goods, speed %, has M.U.L.E., outfit, in pub, lane role, lane price, goal kind, goal
    /// target, goal good, land pick.
    /// </summary>
    public double[] Snapshot()
    {
        var s = State;
        var data = new double[SnapshotHeader + SnapshotPerSeat * s.Players.Length];
        data[0] = s.Month;
        data[1] = (int)s.Phase;
        data[2] = s.ClockTicks;
        data[3] = s.MarketGood;
        data[4] = s.AuctionPlot;
        data[5] = s.HighBid;
        data[6] = s.HighBidder;
        data[7] = (int)s.LastEvent;
        data[8] = s.MarketGood == MatchState.Nobody ? 0 : PoMuleMarket.Floor(s, (Good)s.MarketGood);
        data[9] = s.Store.Mules;
        data[10] = s.LandCursor;
        for (var g = 0; g < 4; g++)
        {
            data[11 + g] = s.Store.Stock[g];
            data[15 + g] = s.Store.Price[g];
        }
        data[19] = s.Store.MulePrice;
        data[20] = s.WampusPlot;
        data[21] = s.CrisisMonths;
        foreach (var p in s.Players)
        {
            var o = SnapshotHeader + p.Seat * SnapshotPerSeat;
            data[o] = p.Cash;
            for (var g = 0; g < 4; g++) data[o + 1 + g] = p.Goods[g];
            data[o + 5] = p.SpeedPercent;
            data[o + 6] = p.HasMule ? 1 : 0;
            data[o + 7] = p.Outfit;
            data[o + 8] = p.InPub ? 1 : 0;
            data[o + 9] = s.LaneRole[p.Seat];
            data[o + 10] = s.LanePrice[p.Seat];
            data[o + 11] = (int)Goals[p.Seat].Kind;
            data[o + 12] = Goals[p.Seat].Target;
            data[o + 13] = (int)Goals[p.Seat].Good;
            data[o + 14] = s.LandPicks[p.Seat];
        }
        return data;
    }
}
