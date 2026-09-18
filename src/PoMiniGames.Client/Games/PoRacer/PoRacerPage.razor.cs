using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Games.PoRacer;

public partial class PoRacerPage
{
    [SupplyParameterFromQuery(Name = "code")] public string? MatchCode { get; set; }
    private enum RacePhase { Start, Racing, Finished }
    private RacePhase _phase;
    private PoRacerSession? _session;
    private readonly CancellationTokenSource _lifetime = new();
    private CancellationTokenSource? _connecting;
    private DotNetObjectReference<PoRacerPage>? _reference;
    private bool _disposed, _engineReady, _isStarting, _isDemo;
    private string _playerName = "", _selectedTrackId = PoRacerCatalog.DefaultTrackId;
    private string? _error, _connectionStatus, _submitStatus;
    private string _announcement = "", _gameCode = "";
    private int? _localCarId;
    private int _totalLaps = PoRacerCatalog.TotalLaps;
    private double _elapsed;
    private int _countdown;
    private bool _raceStarted;
    private IReadOnlyList<PoRacerCarState> _cars = [];
    private PoRacerCarState? Player => _cars.FirstOrDefault(c => c.Id == _localCarId);
    private PoRacerCarCustomization _customization = PoRacerCarCustomization.Default;
    private PoRacerFinalResult? _result;
    private PoRacerScoreDto? _score;
    private bool _submitting;

    protected override void OnInitialized()
    {
        _playerName = PlayerNameService.GetPlayerName();
        _selectedTrackId = PoRacerCatalog.GetTrack(LocalStorageService.GetItem<string>("PoRacer.SelectedTrack")).Id;
        _customization = PoRacerPreferences.LoadCustomization();
        GameStats.SaveLastPlayedGame("poracer");
    }

    protected override async Task OnParametersSetAsync()
    {
        var demo = Nav.Uri.Contains("/poracer/demo", StringComparison.OrdinalIgnoreCase);
        if (_engineReady && demo != _isDemo) await RestartRaceAsync();
        _isDemo = demo;
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (!firstRender) return;
        _reference = DotNetObjectReference.Create(this);
        try
        {
            _engineReady = await JS.InvokeAsync<bool>("loadEngine", "poracer");
            if (!_engineReady) { _error = "The track could not load. Reload this page to try again."; StateHasChanged(); return; }
            await JS.InvokeVoidAsync("PoRacer.start", "racerCanvas", _reference);
            if (_isDemo) Kiosk.SetCurrent("poracer-demo");
            StateHasChanged();
            if (_isDemo || !string.IsNullOrWhiteSpace(MatchCode)) await StartRaceAsync();
        }
        catch (JSException)
        {
            _error = "The track could not load. Reload this page to try again.";
            StateHasChanged();
        }
    }

    private void SelectTrack(string trackId)
    {
        _selectedTrackId = PoRacerCatalog.GetTrack(trackId).Id;
        LocalStorageService.SetItem("PoRacer.SelectedTrack", _selectedTrackId);
    }

    private async Task StartRaceAsync()
    {
        if (_isStarting || !_engineReady || _disposed) return;
        _isStarting = true;
        _error = null;
        _connecting = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        _connecting.CancelAfter(TimeSpan.FromSeconds(10));
        var session = new PoRacerSession(Endpoints);
        _session = session;
        session.Joined += snapshot => InvokeAsync(() => ApplyJoinAsync(snapshot));
        session.SnapshotReceived += snapshot => InvokeAsync(() => ApplySnapshotAsync(snapshot));
        session.Finished += result => InvokeAsync(() => FinishAsync(result));
        session.StatusChanged += status => InvokeAsync(() => { if (!_disposed) { _connectionStatus = status; StateHasChanged(); } });
        try
        {
            _gameCode = _isDemo ? "DEMO" : !string.IsNullOrWhiteSpace(MatchCode) ? MatchCode : "solo-" + Guid.NewGuid().ToString("N");
            await JS.InvokeVoidAsync("PoRacer.start", "racerCanvas", _reference);
            await session.ConnectAsync(_gameCode, !_isDemo, _selectedTrackId, _connecting.Token);
            if (_result is null) _phase = RacePhase.Racing;
            await JS.InvokeVoidAsync("PoRacer.setInputEnabled", !_isDemo && _result is null);
        }
        catch (OperationCanceledException)
        {
            if (!_disposed) _error = "The connection timed out. Try starting the race again.";
            await session.DisposeAsync();
            if (ReferenceEquals(_session, session)) _session = null;
        }
        catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException or Microsoft.AspNetCore.SignalR.HubException)
        {
            _error = "Could not join this race. Try again or return to the multiplayer lobby.";
            await session.DisposeAsync();
            if (ReferenceEquals(_session, session)) _session = null;
        }
        finally
        {
            _connecting?.Dispose();
            _connecting = null;
            _isStarting = false;
            if (!_disposed) StateHasChanged();
        }
    }

    private async Task ApplyJoinAsync(PoRacerRaceSnapshot snapshot)
    {
        if (_disposed) return;
        _localCarId = snapshot.LocalCarId;
        if (snapshot.Static is { } world)
        {
            _selectedTrackId = world.TrackId;
            _totalLaps = world.TotalLaps;
            await JS.InvokeVoidAsync("PoRacerRender.setStatic", world.CenterXY, world.TrackWidth, world.WallsXY,
                world.BoostPads, world.SurfaceZones, world.Theme);
        }
        await ApplySnapshotAsync(snapshot);
    }

    private async Task ApplySnapshotAsync(PoRacerRaceSnapshot snapshot)
    {
        if (_disposed) return;
        _cars = snapshot.Cars;
        _elapsed = snapshot.ElapsedRaceTime;
        _countdown = snapshot.CountdownSeconds;
        _raceStarted = snapshot.Started;
        await JS.InvokeVoidAsync("PoRacerRender.drawSnapshot", "racerCanvas", "racerMinimap",
            snapshot.ElapsedRaceTime, 1, _cars.Select(c => new
            {
                x = c.X,
                y = c.Y,
                h = c.Heading,
                v = c.Speed,
                color = c.Id == _localCarId ? _customization.ColorHex : c.Color,
                colorDark = c.ColorDark,
                isPlayer = c.Id == _localCarId,
                name = c.Name,
                lap = c.Lap,
                position = c.Position,
                finished = c.Finished,
                boost = c.BoostGlow,
                skid = c.SkidIntensity,
                surface = c.Surface,
                livery = c.Id == _localCarId ? _customization.LiveryPattern : c.LiveryStyle
            }).ToArray(), snapshot.ServerTimeMs);
        if (_raceStarted) await UpdateAudioAsync();
        StateHasChanged();
    }

    private async Task FinishAsync(PoRacerFinalResult result)
    {
        if (_disposed || _result is not null) return;
        _result = result;
        _phase = RacePhase.Finished;
        await JS.InvokeVoidAsync("PoRacer.setInputEnabled", false);
        if (_isDemo) Kiosk.MarkFinished();
        else
        {
            var mine = result.Standings.FirstOrDefault(s => s.CarId == _localCarId);
            if (mine is not null)
            {
                await GameResults.RecordAsync("poracer", _playerName, Difficulty.Medium, mine.Position == 1 ? GameResult.Win : GameResult.Loss);
                if (double.IsFinite(mine.BestLapSeconds) && mine.BestLapSeconds > 0)
                    _score = new PoRacerScoreDto
                    {
                        BestLapSeconds = mine.BestLapSeconds,
                        FinalPosition = mine.Position,
                        TrackId = _selectedTrackId,
                        GameCode = _gameCode,
                        AchievedAtUtc = result.FinishedAtUtc
                    };
                await SubmitScoreAsync();
            }
        }
        StateHasChanged();
    }

    private async Task SubmitScoreAsync()
    {
        if (_submitting || _score is null || _submitStatus is "Saved" or "Queued") return;
        _submitting = true;
        _submitStatus = "Saving";
        StateHasChanged();
        try
        {
            var submitted = await Api.SubmitPoRacerScoreAsync(_score, _lifetime.Token);
            if (submitted.IsSaved) _submitStatus = "Saved";
            else if (submitted.ShouldRetry)
            {
                ScoreSync.EnqueuePoRacer(_score);
                _submitStatus = "Queued";
            }
            else _submitStatus = "Rejected";
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
        {
            ScoreSync.EnqueuePoRacer(_score);
        }
        finally { _submitting = false; if (!_disposed) StateHasChanged(); }
    }

    [JSInvokable]
    public Task OnInputChange(bool up, bool down, bool left, bool right, bool space) =>
        _session?.SendInputAsync(new PoRacerInput { Up = up, Down = down, Left = left, Right = right, Space = space }) ?? Task.CompletedTask;

    private async Task RestartRaceAsync()
    {
        _connecting?.Cancel();
        if (_isStarting) return;
        if (_session is { } session) { _session = null; await session.DisposeAsync(); }
        await JS.InvokeVoidAsync("PoRacer.stop");
        _phase = RacePhase.Start;
        _cars = [];
        _result = null;
        _score = null;
        _submitStatus = null;
        _localCarId = null;
        _elapsed = 0;
        _countdown = 0;
        _raceStarted = false;
        _connectionStatus = null;
        _announcement = "";
        _lastLap = _lastPosition = 0;
        _boosting = false;
        if (!string.IsNullOrWhiteSpace(MatchCode)) Nav.NavigateTo("/poracer/multi");
        StateHasChanged();
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        await _lifetime.CancelAsync();
        if (!_isStarting && _session is { } session) await session.DisposeAsync();
        try { await JS.InvokeVoidAsync("PoRacer.stop"); } catch (JSDisconnectedException) { }
        _reference?.Dispose();
        _lifetime.Dispose();
    }
}
