using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using PoMiniGames.Shared.Games.PoMule;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services;
using PoMiniGamesClient.Services.Play;
using Radzen;

namespace PoMiniGamesClient.Games.PoMule;

/// <summary>
/// PoMule's page: owns the match (<see cref="PoMuleMatch"/>, all rules in C#), hands the
/// renderer one snapshot per tick, and turns what the renderer reports back into engine calls.
/// </summary>
/// <remarks>
/// The renderer's frame loop is the only clock. It calls <see cref="OnTick"/>; nothing here
/// uses a timer, so a hidden tab or a phone held upright pauses the match for free.
/// </remarks>
public partial class PoMulePage : IAsyncDisposable
{
    private enum Stage { Loading, Intro, Playing, Failed }

    // What the player's avatar is standing on, as the renderer reports it.
    private const int AtOutfitter = 0, AtPub = 1, AtAssay = 2, AtPlot = 3;

    [Parameter] public string? Mode { get; set; }

    [Inject] private IJSRuntime JS { get; set; } = null!;
    [Inject] private PlayerNameService PlayerNameService { get; set; } = null!;
    [Inject] private GameResultService GameResults { get; set; } = null!;
    [Inject] private KioskCoordinator Kiosk { get; set; } = null!;
    [Inject] private NotificationService Notifications { get; set; } = null!;
    [Inject] private PoMuleSaveStore Saves { get; set; } = null!;

    private DotNetObjectReference<PoMulePage>? _ref;
    private PoMuleMatch? _match;
    private MatchState? _saved;
    private List<PoMuleRow> _rows = [];
    private List<StatItem>? _endStats;
    private Stage _stage = Stage.Loading;
    private Species _species = Species.Humanoid;
    private GameResult _outcome = GameResult.InProgress;
    private string _playerName = "";
    private string? _announcement;
    private string _endLine = "";
    private string? _mode;
    private bool _demo;
    private bool _radzenReady;
    private bool _finished;
    private bool _newBest;
    private bool _plotsDirty;
    private bool _disposed;
    private int _whereKind = -1;
    private int _wherePlot;
    private Phase _shownPhase;
    private long _lastRender;

    private int PubPayout => _match is { } m
        ? Math.Min(PoMuleTuning.PubCap, m.State.ClockTicks / PoMuleTuning.TicksPerSecond * (3 + m.State.Month))
        : 0;

    protected override void OnInitialized() => _playerName = PlayerNameService.GetPlayerName();

    protected override async Task OnParametersSetAsync()
    {
        // Blazor reuses this component between /pomule/1player and /pomule/demo.
        if (_mode == (Mode ?? "")) return;
        var first = _mode is null;
        _mode = Mode ?? "";
        _demo = GameModes.Parse(Mode) == GameMode.Demo;
        if (!first) await ResetAsync();
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender) await LoadAsync();
    }

    private async Task LoadAsync()
    {
        try
        {
            if (!await JS.InvokeAsync<bool>("loadEngine", "pomule")) throw new InvalidOperationException("engine");
            _radzenReady = await JS.InvokeAsync<bool>("PoMule.ensureRadzen");
            _saved = _demo ? null : await Saves.LoadAsync();
            _stage = Stage.Intro;
        }
        catch (Exception ex) when (ex is JSException or InvalidOperationException)
        {
            _stage = Stage.Failed;
        }
        StateHasChanged();
    }

    private Task RetryAsync()
    {
        _stage = Stage.Loading;
        return LoadAsync();
    }

    private async Task ResetAsync()
    {
        await StopEngineAsync();
        _match = null;
        _finished = false;
        _outcome = GameResult.InProgress;
        _saved = _demo ? null : await Saves.LoadAsync();
        _stage = Stage.Intro;
    }

    private Task StartNewAsync() =>
        BeginAsync(PoMuleMatch.New((ulong)Random.Shared.NextInt64(1, long.MaxValue), _demo ? null : _species, fast: _demo));

    private Task ContinueAsync() => _saved is { } saved ? BeginAsync(new PoMuleMatch(saved)) : Task.CompletedTask;

    private async Task BeginAsync(PoMuleMatch match)
    {
        _match = match;
        _saved = null;
        _finished = false;
        _newBest = false;
        _outcome = GameResult.InProgress;
        _whereKind = -1;
        _shownPhase = match.State.Phase;
        if (!_demo) match.State.Players[0].Name = string.IsNullOrWhiteSpace(_playerName) ? "You" : _playerName;
        _rows = PoMuleUi.Rows(match.State);
        _stage = Stage.Playing;
        StateHasChanged();

        _ref ??= DotNetObjectReference.Create(this);
        var plots = match.State.Map.Plots;
        await JS.InvokeVoidAsync("PoMule.start", "pomule-canvas", _ref, new
        {
            terrain = plots.Select(p => (int)p.Terrain).ToArray(),
            peaks = plots.Select(p => (int)p.Peaks).ToArray(),
            species = match.State.Players.Select(p => (int)p.Species).ToArray(),
            colors = PoMuleUi.SeatColors,
            human = !_demo,
            speed = _demo ? 4 : 1,
            snapshot = match.Snapshot(),
        });
        await PushPlotsAsync();
    }

    // ── Renderer → engine ──

    /// <summary>The renderer's clock: advance the match and hand back what to draw.</summary>
    [JSInvokable]
    public double[] OnTick(int ticks)
    {
        if (_match is not { } match) return [];
        var state = match.State;
        var monthStarted = match.Advance(ticks);

        foreach (var notice in match.Notices) Announce(notice);
        if (_plotsDirty) _ = PushPlotsAsync();

        if (state.Phase == Phase.Finished)
        {
            if (!_finished) _ = FinishAsync();
        }
        else if (monthStarted && !_demo)
        {
            _ = Saves.SaveAsync(state);
        }

        // The panel does not need sixty updates a second: redraw on a phase change, else four times a second.
        var now = Environment.TickCount64;
        if (state.Phase != _shownPhase || now - _lastRender > 250)
        {
            if (state.Phase != _shownPhase)
            {
                _shownPhase = state.Phase;
                _announcement = $"Month {state.Month}, {PoMuleUi.PhaseName(state.Phase)}.";
                _plotsDirty = true;
            }
            _lastRender = now;
            _rows = PoMuleUi.Rows(state);
            StateHasChanged();
        }
        return match.Snapshot();
    }

    private void Announce(Notice notice)
    {
        var state = _match!.State;
        switch (notice.Kind)
        {
            case NoticeKind.LandGranted:
                _plotsDirty = true;
                break;
            case NoticeKind.AuctionWon:
                _plotsDirty = true;
                Notify(NotificationSeverity.Info, "Sold", $"{state.Players[notice.Seat].Name} wins the plot for {notice.B:N0} cr.");
                break;
            case NoticeKind.MuleRanAway:
                _ = JS.InvokeVoidAsync("PoMule.runaway", notice.Seat);
                if (notice.Seat == 0 && !_demo) Notify(NotificationSeverity.Warning, "Your M.U.L.E. bolted", "It is gone, and so is what you paid for it.");
                break;
            case NoticeKind.PubVisit when notice.Seat == 0 && !_demo:
                Notify(NotificationSeverity.Success, "Pub", $"You win {notice.A:N0} cr at the tables.");
                break;
            case NoticeKind.Traded:
                _ = JS.InvokeVoidAsync("PoMule.trade", notice.Seat, notice.A, notice.B);
                break;
            case NoticeKind.ColonyEvent when (ColonyEvent)notice.A != ColonyEvent.None:
                var colonyEvent = (ColonyEvent)notice.A;
                Notify(NotificationSeverity.Warning, PoMuleEvents.Headline(colonyEvent), PoMuleEvents.Detail(colonyEvent));
                break;
        }
    }

    private void Notify(NotificationSeverity severity, string summary, string detail) =>
        Notifications.Notify(new NotificationMessage { Severity = severity, Summary = summary, Detail = detail, Duration = 4000 });

    [JSInvokable]
    public void OnLandPick(int plot)
    {
        if (_match?.State is { Phase: Phase.Land } state && plot >= 0 && plot < state.Owner.Length)
            state.LandPicks[0] = plot;
    }

    [JSInvokable]
    public void OnBid() => Bid();

    [JSInvokable]
    public void OnArrive(int seat)
    {
        if (_match is null || seat is < 0 or >= PoMuleTuning.Seats) return;
        _match.Arrive(seat);
        foreach (var notice in _match.Notices.Where(n => n.Kind == NoticeKind.MuleRanAway)) Announce(notice);
        _plotsDirty = true;
    }

    [JSInvokable]
    public void OnBump(int seat)
    {
        if (_match is null || seat is < 0 or >= PoMuleTuning.Seats) return;
        if (_match.Bump(seat, dashing: true)) Announce(new Notice(NoticeKind.MuleRanAway, seat));
    }

    [JSInvokable]
    public void OnWhere(int kind, int plot)
    {
        if (_match is null || plot < 0 || plot >= _match.State.Owner.Length) return;
        (_whereKind, _wherePlot) = (kind, plot);
        StateHasChanged();
    }

    [JSInvokable]
    public void OnAction(int action) => Act(action);

    [JSInvokable]
    public void OnMarketInput(int direction)
    {
        if (_match is not null) _match.HumanMarketInput = Math.Sign(direction);
    }

    [JSInvokable]
    public void OnSkip() => SkipStandings();

    // ── The player's own actions (keys, touch buttons and the on-screen buttons all land here) ──

    private void Bid()
    {
        if (_demo || _match is null) return;
        if (!_match.HumanBid() && _match.State.HighBidder != 0)
            Notify(NotificationSeverity.Warning, "Cannot bid", "You do not have the credits for the next raise.");
    }

    private void SkipStandings()
    {
        if (!_demo && _match?.State is { Phase: Phase.Standings } state) state.ClockTicks = 1;
    }

    private void SetRole(sbyte role)
    {
        if (!_demo && _match?.State is { Phase: Phase.Market, MarketGood: >= 0 } state)
            PoMuleMarket.SetRole(state, 0, role);
    }

    private ButtonStyle RoleStyle(sbyte role) =>
        _match?.State.LaneRole[0] == role ? ButtonStyle.Warning : ButtonStyle.Secondary;

    /// <param name="action">0 = the main action for where the avatar stands; 1–4 = outfit for that good.</param>
    private void Act(int action)
    {
        if (_demo || _match?.State is not { Phase: Phase.Development } state) return;
        var me = state.Players[0];
        switch (_whereKind)
        {
            case AtOutfitter when action == 0 && !me.HasMule:
                Report(PoMuleDevelopment.BuyMule(state, 0));
                break;
            case AtOutfitter when action is >= 1 and <= 4:
                // Picking an outfit with nothing in tow buys the M.U.L.E. first.
                if (!me.HasMule && Report(PoMuleDevelopment.BuyMule(state, 0)) != Outcome.Ok) break;
                Report(PoMuleDevelopment.Outfit(state, 0, (Good)(action - 1)));
                break;
            case AtOutfitter:
                Notify(NotificationSeverity.Info, "Outfitter", "Press 1 to 4 to outfit your M.U.L.E.");
                break;
            case AtPub when action == 0:
                _match.HumanPub();
                foreach (var notice in _match.Notices.Where(n => n.Kind == NoticeKind.PubVisit)) Announce(notice);
                break;
            case AtAssay when action == 0:
                if (PoMuleDevelopment.VisitAssayOffice(state, 0) == Outcome.Ok)
                    Notify(NotificationSeverity.Info, "Assay kit", "Walk to any plot and act there to survey it.");
                break;
            case AtPlot when action == 0 && me.HasMule:
                if (Report(PoMuleDevelopment.Install(state, 0, _wherePlot)) == Outcome.Runaway)
                    Announce(new Notice(NoticeKind.MuleRanAway, 0));
                break;
            case AtPlot when action == 0 && me.HoldsAssay:
                if (PoMuleDevelopment.Survey(state, 0, _wherePlot) == Outcome.Ok)
                    Notify(NotificationSeverity.Info, "Survey", $"Crystite level {state.Map.Plots[_wherePlot].Crystite} of 4.");
                break;
        }
        _plotsDirty = true;
        _ = PushPlotsAsync();
        _rows = PoMuleUi.Rows(state);
        StateHasChanged();
    }

    private Outcome Report(Outcome outcome)
    {
        switch (outcome)
        {
            case Outcome.NoCash: Notify(NotificationSeverity.Warning, "Not enough credits", "Sell something at the market first."); break;
            case Outcome.SoldOut: Notify(NotificationSeverity.Warning, "Sold out", "The Store has no M.U.L.E.s. It needs Smithore to build more."); break;
            case Outcome.NotAllowed: Notify(NotificationSeverity.Info, "Not now", "You cannot do that here."); break;
        }
        return outcome;
    }

    // ── Engine → renderer ──

    private async Task PushPlotsAsync()
    {
        if (_match is not { } match || _disposed) return;
        _plotsDirty = false;
        var state = match.State;
        var crystite = new int[state.Owner.Length];
        for (var i = 0; i < crystite.Length; i++)
        {
            // A demo shows only what has been assayed; a player also sees what their species can.
            var visible = _demo ? state.Assayed[i] : PoMuleDevelopment.CanSeeCrystite(state, 0, i);
            crystite[i] = visible ? state.Map.Plots[i].Crystite : 0;
        }
        try
        {
            await JS.InvokeVoidAsync("PoMule.setPlots",
                state.Owner.Select(o => (int)o).ToArray(), state.Installed.Select(o => (int)o).ToArray(), crystite);
        }
        catch (JSException) { /* the page is going away */ }
        catch (JSDisconnectedException) { }
    }

    private async Task FinishAsync()
    {
        _finished = true;
        var state = _match!.State;
        _rows = PoMuleUi.Rows(state);
        var survived = PoMuleScoring.ColonySurvives(_rows.Sum(r => r.NetWorth), state.CrisisMonths);
        StateHasChanged();

        if (_demo)
        {
            Kiosk.MarkFinished();
            // Outside the reel a demo keeps going: show the result, then play another.
            await Task.Delay(8000);
            if (!_disposed && _demo && _finished && !Kiosk.IsActive) await StartNewAsync();
            return;
        }

        await Saves.ClearAsync();
        var mine = _rows.First(r => r.Seat == 0);
        _outcome = mine.Rank == 1 ? GameResult.Win : GameResult.Loss;
        _endLine = (mine.Rank == 1 ? "You are First Founder" : $"You finished {Ordinal(mine.Rank)} of 8")
            + (survived ? ", and the colony survives." : ", but the colony collapsed.");
        _endStats =
        [
            new StatItem { Value = mine.NetWorth.ToString("N0"), Label = "Net Worth" },
            new StatItem { Value = $"{mine.Rank}/8", Label = "Place" },
            new StatItem { Value = mine.Plots.ToString(), Label = "Plots" },
            new StatItem { Value = survived ? "Survived" : "Collapsed", Label = "Colony" },
        ];
        StateHasChanged();

        try
        {
            await GameResults.RecordAndSubmitPoMuleAsync(_playerName, _outcome,
                new PoMuleRunRequest(Math.Clamp(mine.NetWorth, 0, PoMiniGames.Domain.Models.PoMuleHighScore.MaxNetWorth), (int)state.Players[0].Species, survived),
                onNewBest: best => _newBest = best);
            StateHasChanged();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[PoMule] score submit failed: {ex.Message}");
        }
    }

    private static string Ordinal(int n) => n switch { 1 => "1st", 2 => "2nd", 3 => "3rd", _ => $"{n}th" };

    private async Task StopEngineAsync()
    {
        try { await JS.InvokeVoidAsync("PoMule.stop"); }
        catch (JSException) { }
        catch (JSDisconnectedException) { }
    }

    public async ValueTask DisposeAsync()
    {
        _disposed = true;
        // A match abandoned mid-month resumes from the last month start; nothing to save here.
        await StopEngineAsync();
        try { await JS.InvokeVoidAsync("PoMule.removeRadzen"); }
        catch (JSException) { }
        catch (JSDisconnectedException) { }
        _ref?.Dispose();
        GC.SuppressFinalize(this);
    }
}
