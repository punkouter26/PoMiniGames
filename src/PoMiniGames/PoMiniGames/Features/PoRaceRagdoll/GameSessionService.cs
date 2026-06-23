using System.Collections.Concurrent;

namespace PoMiniGames.Features.PoRaceRagdoll;

public interface IGameSessionService
{
    string CreateSession();
    GameState? GetSession(string sessionId);
    (GameState? State, PlaceBetOutcome Outcome) PlaceBet(string sessionId, int racerId);
    (GameState? State, RaceResult? Result) FinishRace(string sessionId);
    GameState? NextRound(string sessionId);
}

public sealed class GameSessionService(
    IRacerService racerService,
    ILogger<GameSessionService> logger,
    TimeProvider? timeProvider = null) : IGameSessionService
{
    private readonly IRacerService _racerService = racerService;
    private readonly ILogger<GameSessionService> _logger = logger;
    private readonly TimeProvider _timeProvider = timeProvider ?? TimeProvider.System;
    private readonly ConcurrentDictionary<string, MutableGameState> _sessions = new();
    private readonly ConcurrentDictionary<string, object> _sessionLocks = new();
    private readonly object _createLock = new();
    private readonly TimeSpan _sessionTimeout = TimeSpan.FromMinutes(30);
    private readonly TimeSpan _cleanupInterval = TimeSpan.FromMinutes(5);
    private readonly TimeSpan _raceTimeout = TimeSpan.FromMinutes(5);
    private DateTime _lastCleanup = (timeProvider ?? TimeProvider.System).GetUtcNow().UtcDateTime;

    private object GetSessionLock(string sessionId) =>
        _sessionLocks.GetOrAdd(sessionId, _ => new object());

    private void CleanupOldSessions()
    {
        var now = _timeProvider.GetUtcNow().UtcDateTime;
        if (now - _lastCleanup < _cleanupInterval) return;

        _lastCleanup = now;
        var threshold = now - _sessionTimeout;

        var keysToRemove = _sessions
            .Where(kvp => kvp.Value.LastAccessed < threshold)
            .Select(kvp => kvp.Key)
            .ToList();

        foreach (var key in keysToRemove)
        {
            _sessions.TryRemove(key, out _);
            _sessionLocks.TryRemove(key, out _);
        }

        if (keysToRemove.Count > 0)
            _logger.LogInformation("Cleaned up {Count} expired race sessions", keysToRemove.Count);
    }

    public string CreateSession()
    {
        var sessionId = Guid.NewGuid().ToString("N");
        var racers = _racerService.GenerateRacers();
        var now = _timeProvider.GetUtcNow().UtcDateTime;

        lock (_createLock)
        {
            CleanupOldSessions();
            _sessions[sessionId] = new MutableGameState
            {
                Balance = GameConfig.InitialBalance,
                Round = 1,
                MaxRounds = GameConfig.TotalRounds,
                State = GamePhase.Betting,
                Racers = racers.ToList(),
                BetAmount = GameConfig.InitialBet,
                LastAccessed = now
            };
        }

        return sessionId;
    }

    public GameState? GetSession(string sessionId)
    {
        lock (GetSessionLock(sessionId))
        {
            if (!_sessions.TryGetValue(sessionId, out var state)) return null;

            ResolveStaleRace(sessionId, state);

            state.LastAccessed = _timeProvider.GetUtcNow().UtcDateTime;
            return state.ToImmutable();
        }
    }

    public (GameState? State, PlaceBetOutcome Outcome) PlaceBet(string sessionId, int racerId)
    {
        lock (GetSessionLock(sessionId))
        {
            if (!_sessions.TryGetValue(sessionId, out var state)) return (null, PlaceBetOutcome.NotFound);
            if (state.State != GamePhase.Betting) return (state.ToImmutable(), PlaceBetOutcome.WrongPhase);
            if (state.Balance < state.BetAmount) return (state.ToImmutable(), PlaceBetOutcome.InsufficientBalance);
            if (state.BetAmount <= 0) return (state.ToImmutable(), PlaceBetOutcome.InsufficientBalance);
            if (racerId < 0 || racerId >= state.Racers.Count) return (state.ToImmutable(), PlaceBetOutcome.InvalidRacer);

            state.SelectedRacerId = racerId;
            state.Balance -= state.BetAmount;
            state.State = GamePhase.Racing;
            state.RaceStartedAt = _timeProvider.GetUtcNow().UtcDateTime;
            // Seal the winner server-side so the client cannot spoof the outcome.
            state.ServerWinnerId = PickServerWinner(state.Racers);
            return (state.ToImmutable(), PlaceBetOutcome.Success);
        }
    }

    public (GameState? State, RaceResult? Result) FinishRace(string sessionId)
    {
        lock (GetSessionLock(sessionId))
        {
            if (!_sessions.TryGetValue(sessionId, out var state)) return (null, null);
            if (state.State != GamePhase.Racing) return (state.ToImmutable(), null);
            if (state.ServerWinnerId is null) return (state.ToImmutable(), null);

            var winner = state.Racers.FirstOrDefault(r => r.Id == state.ServerWinnerId.Value);
            if (winner is null) return (state.ToImmutable(), null);

            var playerWon = state.SelectedRacerId == state.ServerWinnerId.Value;
            var payout = _racerService.CalculatePayout(state.BetAmount, winner.Odds, playerWon);

            state.Balance += payout;
            state.WinnerId = state.ServerWinnerId.Value;
            state.State = GamePhase.Finished;

            var result = new RaceResult(
                WinnerId: state.ServerWinnerId.Value,
                WinnerName: winner.Name,
                PlayerWon: playerWon,
                Payout: payout,
                NewBalance: state.Balance
            );

            return (state.ToImmutable(), result);
        }
    }

    public GameState? NextRound(string sessionId)
    {
        lock (GetSessionLock(sessionId))
        {
            if (!_sessions.TryGetValue(sessionId, out var state)) return null;
            if (state.State != GamePhase.Finished) return state.ToImmutable();

            if (state.Round >= state.MaxRounds)
            {
                state.Round = 1;
                state.Balance = GameConfig.InitialBalance;
            }
            else
            {
                state.Round++;
            }

            state.Racers = _racerService.GenerateRacers().ToList();
            state.State = GamePhase.Betting;
            state.SelectedRacerId = null;
            state.WinnerId = null;
            return state.ToImmutable();
        }
    }

    private sealed class MutableGameState
    {
        public int Balance { get; set; }
        public int Round { get; set; }
        public int MaxRounds { get; set; }
        public GamePhase State { get; set; } = GamePhase.Betting;
        public List<Racer> Racers { get; set; } = [];
        public int? SelectedRacerId { get; set; }
        public int BetAmount { get; set; }
        public int? WinnerId { get; set; }
        public int? ServerWinnerId { get; set; }
        public DateTime LastAccessed { get; set; } = DateTime.UtcNow;
        public DateTime? RaceStartedAt { get; set; }

        public GameState ToImmutable() => new(
            Balance, Round, MaxRounds, State,
            Racers.AsReadOnly(),
            SelectedRacerId, BetAmount, WinnerId
        );
    }

    /// <summary>
    /// Detects and resolves a race that exceeded <see cref="_raceTimeout"/>.
    /// Extracted from <see cref="GetSession"/> to honour Command-Query Separation —
    /// the mutation is explicit and logged rather than silently buried in a read.
    /// </summary>
    private void ResolveStaleRace(string sessionId, MutableGameState state)
    {
        if (state.State != GamePhase.Racing || !state.RaceStartedAt.HasValue) return;

        var elapsed = _timeProvider.GetUtcNow().UtcDateTime - state.RaceStartedAt.Value;
        if (elapsed <= _raceTimeout) return;

        _logger.LogWarning(
            "Race timeout for session {SessionId} after {Elapsed:g}; refunding ${BetAmount}",
            sessionId, elapsed, state.BetAmount);

        state.Balance += state.BetAmount;
        state.State = GamePhase.Betting;
        state.SelectedRacerId = null;
        state.RaceStartedAt = null;
        state.ServerWinnerId = null;
    }

    /// <summary>
    /// Picks a winner using weighted random selection based on each racer's American-odds probability.
    /// American odds: negative = favourite (e.g. -150 → 60 % win chance),
    ///                positive = underdog  (e.g. +200 → 33 % win chance).
    /// </summary>
    private static int PickServerWinner(List<Racer> racers)
    {
        if (racers.Count == 0) return 0;

        // Convert American odds to implied probability for each racer.
        var weights = racers.Select(r =>
        {
            double p = r.Odds < 0
                ? Math.Abs(r.Odds) / (Math.Abs(r.Odds) + 100.0)
                : 100.0 / (r.Odds + 100.0);
            return Math.Max(p, 0.01); // floor to avoid zero-weight racers
        }).ToList();

        double total = weights.Sum();
        double roll = Random.Shared.NextDouble() * total;
        double cumulative = 0;
        for (int i = 0; i < racers.Count; i++)
        {
            cumulative += weights[i];
            if (roll < cumulative) return racers[i].Id;
        }
        return racers[^1].Id;
    }
}
