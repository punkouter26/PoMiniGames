namespace PoMiniGames.Features.PoRaceRagdoll;

public interface IGameSessionService
{
    string CreateSession();
    GameState? GetSession(string sessionId);
    GameState? PlaceBet(string sessionId, int racerId);
    (GameState? State, RaceResult? Result) FinishRace(string sessionId, int winnerId);
    GameState? NextRound(string sessionId);
}

public sealed class GameSessionService : IGameSessionService
{
    private readonly IRacerService _racerService;
    private readonly IOddsService _oddsService;
    private readonly Dictionary<string, MutableGameState> _sessions = new();
    private readonly Lock _lock = new();
    private readonly TimeSpan _sessionTimeout = TimeSpan.FromMinutes(30);
    private readonly TimeSpan _cleanupInterval = TimeSpan.FromMinutes(5);
    private readonly TimeSpan _raceTimeout = TimeSpan.FromMinutes(5);
    private DateTime _lastCleanup = DateTime.UtcNow;

    public GameSessionService(IRacerService racerService, IOddsService oddsService)
    {
        _racerService = racerService;
        _oddsService = oddsService;
    }

    private void CleanupOldSessions()
    {
        var now = DateTime.UtcNow;
        if (now - _lastCleanup < _cleanupInterval) return;

        _lastCleanup = now;
        var threshold = now - _sessionTimeout;

        var keysToRemove = _sessions
            .Where(kvp => kvp.Value.LastAccessed < threshold)
            .Select(kvp => kvp.Key)
            .ToList();

        foreach (var key in keysToRemove)
            _sessions.Remove(key);

        if (keysToRemove.Count > 0)
            Console.WriteLine($"[GameSessionService] Cleaned up {keysToRemove.Count} expired sessions");
    }

    public string CreateSession()
    {
        var sessionId = Guid.NewGuid().ToString("N");
        var racers = _racerService.GenerateRacers();

        lock (_lock)
        {
            CleanupOldSessions();
            _sessions[sessionId] = new MutableGameState
            {
                Balance = GameConfig.InitialBalance,
                Round = 1,
                MaxRounds = GameConfig.TotalRounds,
                State = "BETTING",
                Racers = racers.ToList(),
                BetAmount = GameConfig.InitialBet,
                LastAccessed = DateTime.UtcNow
            };
        }

        return sessionId;
    }

    public GameState? GetSession(string sessionId)
    {
        lock (_lock)
        {
            if (!_sessions.TryGetValue(sessionId, out var state)) return null;

            if (state.State == "RACING" && state.RaceStartedAt.HasValue)
            {
                var elapsed = DateTime.UtcNow - state.RaceStartedAt.Value;
                if (elapsed > _raceTimeout)
                {
                    state.Balance += state.BetAmount;
                    state.State = "BETTING";
                    state.SelectedRacerId = null;
                    state.RaceStartedAt = null;
                }
            }

            state.LastAccessed = DateTime.UtcNow;
            return state.ToImmutable();
        }
    }

    public GameState? PlaceBet(string sessionId, int racerId)
    {
        lock (_lock)
        {
            if (!_sessions.TryGetValue(sessionId, out var state)) return null;
            if (state.State != "BETTING") return state.ToImmutable();
            if (state.Balance < state.BetAmount) return state.ToImmutable();
            if (racerId < 0 || racerId >= state.Racers.Count) return state.ToImmutable();

            state.SelectedRacerId = racerId;
            state.Balance -= state.BetAmount;
            state.State = "RACING";
            state.RaceStartedAt = DateTime.UtcNow;
            return state.ToImmutable();
        }
    }

    public (GameState? State, RaceResult? Result) FinishRace(string sessionId, int winnerId)
    {
        lock (_lock)
        {
            if (!_sessions.TryGetValue(sessionId, out var state)) return (null, null);
            if (state.State != "RACING") return (state.ToImmutable(), null);

            var winner = state.Racers.FirstOrDefault(r => r.Id == winnerId);
            if (winner is null) return (state.ToImmutable(), null);

            var playerWon = state.SelectedRacerId == winnerId;
            var payout = _oddsService.CalculatePayout(state.BetAmount, winner.Odds, playerWon);

            state.Balance += payout;
            state.WinnerId = winnerId;
            state.State = "FINISHED";

            var result = new RaceResult(
                WinnerId: winnerId,
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
        lock (_lock)
        {
            if (!_sessions.TryGetValue(sessionId, out var state)) return null;
            if (state.State != "FINISHED") return state.ToImmutable();

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
            state.State = "BETTING";
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
        public string State { get; set; } = "BETTING";
        public List<Racer> Racers { get; set; } = [];
        public int? SelectedRacerId { get; set; }
        public int BetAmount { get; set; }
        public int? WinnerId { get; set; }
        public DateTime LastAccessed { get; set; } = DateTime.UtcNow;
        public DateTime? RaceStartedAt { get; set; }

        public GameState ToImmutable() => new(
            Balance, Round, MaxRounds, State,
            Racers.AsReadOnly(),
            SelectedRacerId, BetAmount, WinnerId
        );
    }
}
