namespace PoSurvive.Client.Services;

using System.Text.Json;
using Fluxor;
using PoSurvive.Application.DTOs;
using PoSurvive.Application.Services;
using PoSurvive.Client.Store;
using PoSurvive.Domain.Entities;
using PoSurvive.Domain.Enums;
using PoSurvive.Domain.ValueObjects;
using PoSurvive.Shared.Interfaces;
using PoSurvive.Shared.Models;
using PoSurvive.Shared.Constants;

/// <summary>
/// Singleton service that holds the mutable domain model for a running simulation and
/// orchestrates heartbeat ticks on a timer. Pure Fluxor state is updated via dispatched
/// actions after each tick.
/// </summary>
public sealed class SimulationOrchestrator : IDisposable
{
    private const int MinPerAgentInferenceMs = 1_200;
    private const int MaxPerAgentInferenceMs = 10_000;
    private const int MinTurnInferenceBudgetMs = 6_000;
    private const int MaxTurnInferenceBudgetMs = 20_000;

    private readonly IDispatcher           _dispatcher;
    private readonly IInferenceService     _inference;
    private readonly GridService           _gridSvc;
    private readonly SimulationEngine      _engine;
    private readonly NarrativeService      _narrative;
    private readonly EvolutionClientService _evolutionClient;

    // ─── Mutable runtime state ────────────────────────────────────────────
    private GridTile[]?        _grid;
    private List<Agent>?       _agents;
    private SimulationConfig?  _config;
    private Guid               _sessionId;
    private DateTimeOffset     _startedAt;
    private int                _turn;
    private int                _inferenceRoundRobinOffset;
    private bool               _isMock;
    private readonly Random    _rng = new();

    // HeartbeatEvents accumulated for the current session
    private readonly List<HeartbeatEventDto> _sessionLog = [];
    private readonly Dictionary<string, (string Thought, string Action)> _inferenceCache = new();

    private System.Timers.Timer? _timer;
    private bool                 _ticking;
    private bool                 _stopped;
    private bool                 _paused;
    private readonly object      _stateLock = new();

    public SimulationOrchestrator(
        IDispatcher            dispatcher,
        IInferenceService      inference,
        GridService            gridSvc,
        SimulationEngine       engine,
        NarrativeService       narrative,
        EvolutionClientService evolutionClient)
    {
        _dispatcher      = dispatcher;
        _inference       = inference;
        _gridSvc         = gridSvc;
        _engine          = engine;
        _narrative       = narrative;
        _evolutionClient = evolutionClient;
    }

    // ─── Public API ───────────────────────────────────────────────────────

    /// <summary>Builds the grid, places agents, and starts the heartbeat timer.</summary>
    public void Initialize(SimulationConfigDto configDto, bool isMockProvider)
    {
        _config    = MapConfig(configDto);
        _sessionId = Guid.NewGuid();
        _startedAt = DateTimeOffset.UtcNow;
        _turn      = 0;
        _inferenceRoundRobinOffset = 0;
        _isMock    = isMockProvider;
        _sessionLog.Clear();

        _grid   = _gridSvc.GenerateGrid(_config, _rng);
        _agents = _gridSvc.CreateAgents(_config, _rng);
        _gridSvc.PlaceAgents(_grid, _agents, _rng);

        // Build rock list for state (immutable for this session)
        var rocks = _grid
            .Where(t => t.Terrain == TerrainType.Rock)
            .Select(t => new GridCoordinateDto(t.X, t.Y))
            .ToList();

        _dispatcher.Dispatch(new SimulationInitialisedAction(
            SessionId:     _sessionId,
            Agents:        MapAgents(),
            Rocks:         rocks,
            Config:        configDto,
            IsMockProvider: isMockProvider));

        StartTimer(_config.HeartbeatMaxMs);
    }

    /// <summary>Executes one heartbeat tick (called from the timer callback).</summary>
    public async Task TickAsync()
    {
        lock (_stateLock)
        {
            if (_ticking || _stopped || _paused || _grid is null || _agents is null || _config is null)
                return;
            _ticking = true;
        }

        try
        {
            _turn++;
            var hpBefore = _agents.ToDictionary(a => a.Id, a => (Hp: a.Hp, Hunger: a.Hunger));

            // 1. Gather inferred actions for all alive agents
            var resolvedActions = await InferActionsAsync();

            // 2. Run engine tick
            var result = _engine.Tick(_grid, _agents, _turn, _config, resolvedActions, _rng);

            // 3. Build console entries
            var newEntries = _agents
                .Select(a => new ConsoleEntry(
                    TurnNumber: _turn,
                    AgentId:    a.Id,
                    Team:       a.Team.ToString(),
                    Thought:    a.LastThought ?? "(thinking…)",
                    Action:     a.LastAction?.ToString() ?? "Idle"))
                .ToList();

            // 4. Build heartbeat DTOs for session log
            var gridJson  = SerialiseGrid();
            var heartbeats = _agents.Select(a =>
            {
                var before = hpBefore.TryGetValue(a.Id, out var b) ? b : (Hp: a.Hp, Hunger: a.Hunger);
                return new HeartbeatEventDto(
                    SessionId:    _sessionId,
                    TurnNumber:   _turn,
                    AgentId:      a.Id,
                    Team:         a.Team.ToString(),
                    ThoughtText:  a.LastThought ?? "",
                    ActionTaken:  a.LastAction?.ToString() ?? "Idle",
                    HpBefore:     before.Hp,
                    HpAfter:      a.Hp,
                    HungerBefore: before.Hunger,
                    HungerAfter:  a.Hunger,
                    GridSnapshot: gridJson);
            }).ToList();

            _sessionLog.AddRange(heartbeats);

            // 5. Dispatch per-death notifications (for audio)
            foreach (var deadId in result.DiedThisTurn)
            {
                var deadAgent = _agents.FirstOrDefault(a => a.Id == deadId);
                if (deadAgent is not null)
                    _dispatcher.Dispatch(new AgentDiedAction(deadId, deadAgent.Team.ToString()));
            }

            // 6. Dispatch heartbeat completed
            string? outcome    = result.Outcome?.ToString();
            string? winnerTeam = result.WinningTeam?.ToString();

            _dispatcher.Dispatch(new HeartbeatCompletedAction(
                TurnNumber:      _turn,
                Agents:          MapAgents(),
                FoodNodes:       MapFoodNodes(),
                NewEntries:      newEntries,
                Outcome:         outcome,
                WinningTeam:     winnerTeam,
                HeartbeatEvents: heartbeats));

            // 7. If simulation ended, stop timer, record evolution, and generate narrative
            if (result.Outcome is not null)
            {
                StopTimer();
                await RecordEvolutionAsync(result.Outcome.Value, result.WinningTeam);
                await GeneratePostMortemAsync(result.Outcome.Value, result.WinningTeam);
            }
        }
        finally
        {
            lock (_stateLock)
            {
                _ticking = false;
            }
        }
    }

    /// <summary>Updates the heartbeat timer interval.</summary>
    public void SetSpeed(int ms)
    {
        if (_timer is not null)
            _timer.Interval = Math.Clamp(ms, 50, 5000);
    }

    /// <summary>Pauses the heartbeat timer without resetting state.</summary>
    public void Pause()
    {
        lock (_stateLock)
        {
            _paused = true;
            _timer?.Stop();
        }
    }

    /// <summary>Resumes the heartbeat timer after a pause.</summary>
    public void Resume()
    {
        if (_stopped) return;
        lock (_stateLock)
        {
            _paused = false;
            _timer?.Start();
        }
    }

    /// <summary>Stops timer and clears all mutable state.</summary>
    public void Reset()
    {
        StopTimer();
        lock (_stateLock)
        {
            _grid      = null;
            _agents    = null;
            _config    = null;
            _sessionLog.Clear();
            _inferenceCache.Clear();
            _turn      = 0;
            _paused    = false;
            _inferenceRoundRobinOffset = 0;
        }
    }

    public void Dispose() => StopTimer();

    // ─── Private helpers ──────────────────────────────────────────────────

    private void StartTimer(int intervalMs)
    {
        StopTimer();
        lock (_stateLock)
        {
            _stopped = false;
            _timer = new System.Timers.Timer(intervalMs);
            _timer.Elapsed += async (_, _) => await TickAsync();
            _timer.AutoReset = true;
            _timer.Start();
        }
    }

    private void StopTimer()
    {
        lock (_stateLock)
        {
            _stopped = true;
            _timer?.Stop();
            _timer?.Dispose();
            _timer = null;
        }
    }

    private async Task<IReadOnlyDictionary<string, AgentAction>> InferActionsAsync()
    {
        var dict     = new Dictionary<string, AgentAction>();
        var aliveAgents = _agents!
            .Where(a => a.IsAlive)
            .ToList();

        if (aliveAgents.Count == 0)
            return dict;

        var configuredTimeoutMs = _config?.InferenceTimeoutMs ?? 10_000;
        var configuredMaxInferredAgents = _config?.MaxInferredAgentsPerTurn ?? aliveAgents.Count;
        var maxInferredAgentsPerTurn = Math.Clamp(configuredMaxInferredAgents, 1, aliveAgents.Count);

        var rotationOffset = _inferenceRoundRobinOffset % aliveAgents.Count;
        var rotatedAgents = aliveAgents
            .Skip(rotationOffset)
            .Concat(aliveAgents.Take(rotationOffset))
            .ToList();

        var agentsToInfer = rotatedAgents
            .Take(maxInferredAgentsPerTurn)
            .ToList();
        var skippedAgents = rotatedAgents
            .Skip(maxInferredAgentsPerTurn)
            .ToList();

        _inferenceRoundRobinOffset = (_inferenceRoundRobinOffset + maxInferredAgentsPerTurn) % aliveAgents.Count;

        var turnBudgetMs = Math.Clamp(configuredTimeoutMs, MinTurnInferenceBudgetMs, MaxTurnInferenceBudgetMs);
        var turnDeadline = DateTimeOffset.UtcNow.AddMilliseconds(turnBudgetMs);

        for (var i = 0; i < agentsToInfer.Count; i++)
        {
            var agent = agentsToInfer[i];

            if (_isMock)
            {
                var fallback = GetFallbackInference(agent, "mock", preferReuseLastAction: false);
                agent.LastThought = fallback.Thought;
                dict[agent.Id] = fallback.Action;
                continue;
            }

            var remainingMs = (int)(turnDeadline - DateTimeOffset.UtcNow).TotalMilliseconds;
            var agentsLeft = agentsToInfer.Count - i;

            if (remainingMs <= 0)
            {
                for (var j = i; j < agentsToInfer.Count; j++)
                {
                    var pendingAgent = agentsToInfer[j];
                    var fallback = GetFallbackInference(pendingAgent, "budget_exhausted", preferReuseLastAction: false);
                    pendingAgent.LastThought = fallback.Thought;
                    dict[pendingAgent.Id] = fallback.Action;
                }
                break;
            }

            var perAgentTimeoutMs = Math.Clamp(remainingMs / Math.Max(agentsLeft, 1), MinPerAgentInferenceMs, MaxPerAgentInferenceMs);
            var dnaDto = new PersonalityDnaDto(
                agent.Dna.Predatory,
                agent.Dna.Scavenger,
                agent.Dna.Paranoid,
                agent.Dna.Altruistic,
                agent.Dna.Methodical);

            using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(perAgentTimeoutMs));
            using var inferScope = (_inference as WebLlmInferenceService)
                ?.BeginDiagnosticsScope(_turn, agent.Id, agent.Team.ToString());

            try
            {
                var localGridJson = SerialiseLocalGrid(agent, 3);
                var cacheKey = $"{agent.Hp}_{agent.Hunger}_{localGridJson}";
                
                if (_inferenceCache.TryGetValue(cacheKey, out var cached))
                {
                    agent.LastThought = cached.Thought;
                    dict[agent.Id] = Enum.TryParse<AgentAction>(cached.Action, true, out var p) ? p : AgentAction.Idle;
                    continue;
                }

                var result = await _inference.InferAsync(localGridJson, dnaDto, cts.Token);
                agent.LastThought = result.Thought;
                _inferenceCache[cacheKey] = (result.Thought, result.Action);

                var action = Enum.TryParse<AgentAction>(result.Action, true, out var parsed)
                    ? parsed
                    : AgentAction.Idle;

                dict[agent.Id] = action;
            }
            catch (OperationCanceledException)
            {
                var fallback = GetFallbackInference(agent, "timeout");
                agent.LastThought = $"Inference timed out after {perAgentTimeoutMs} ms. {fallback.Thought}";
                dict[agent.Id] = fallback.Action;
            }
            catch
            {
                var fallback = GetFallbackInference(agent, "unavailable");
                agent.LastThought = fallback.Thought;
                dict[agent.Id] = fallback.Action;
            }
        }

        foreach (var skippedAgent in skippedAgents)
        {
            var fallback = GetFallbackInference(skippedAgent, "deferred");
            skippedAgent.LastThought = fallback.Thought;
            dict[skippedAgent.Id] = fallback.Action;
        }

        foreach (var agent in aliveAgents)
        {
            if (!dict.ContainsKey(agent.Id))
            {
                var fallback = GetFallbackInference(agent, "missing", preferReuseLastAction: false);
                agent.LastThought = fallback.Thought;
                dict[agent.Id] = fallback.Action;
            }
        }

        return dict;
    }

    private (string Thought, AgentAction Action) GetFallbackInference(
        Agent agent,
        string reason,
        bool preferReuseLastAction = true)
    {
        var thought = $"Inference {reason.Replace('_', ' ')}. Standing by.";

        // Momentum continuity: re-use last non-Idle action when preferred
        if (preferReuseLastAction
            && agent.LastAction is not null
            && agent.LastAction != AgentAction.Idle)
        {
            return (thought, agent.LastAction.Value);
        }

        // Trait-driven diversified fallback so agents don't all idle → starve
        var dominantTrait = GetDominantTrait(agent.Dna);
        var action = GetDiversifiedFallbackAction(agent.Id, dominantTrait);
        return (thought, action);
    }

    private AgentAction GetDiversifiedFallbackAction(string agentId, string dominantTrait)
    {
        var sequence = dominantTrait switch
        {
            "Predatory" => new[] { AgentAction.Attack, AgentAction.Flee, AgentAction.Forage },
            "Scavenger" => new[] { AgentAction.Forage, AgentAction.Idle, AgentAction.Flee },
            "Paranoid" => new[] { AgentAction.Flee, AgentAction.Forage, AgentAction.Idle },
            "Altruistic" => new[] { AgentAction.Idle, AgentAction.Forage, AgentAction.Flee },
            "Methodical" => new[] { AgentAction.Forage, AgentAction.Idle, AgentAction.Attack },
            _ => new[] { AgentAction.Idle, AgentAction.Forage, AgentAction.Flee },
        };

        var hash = HashCode.Combine(agentId, _turn);
        var index = (hash & int.MaxValue) % sequence.Length;
        return sequence[index];
    }

    private static string GetDominantTrait(PersonalityDna dna)
    {
        var traits = new (float Weight, string Name)[]
        {
            (dna.Predatory,  "Predatory"),
            (dna.Scavenger,  "Scavenger"),
            (dna.Paranoid,   "Paranoid"),
            (dna.Altruistic, "Altruistic"),
            (dna.Methodical, "Methodical"),
        };

        return traits.MaxBy(t => t.Weight).Name;
    }

    private async Task RecordEvolutionAsync(SimulationOutcome outcome, TeamColor? winner)
    {
        try
        {
            var winningTeam = winner?.ToString();
            var agentResults = _agents!.Select(a => new AgentEvolutionResult(
                Predatory:        a.Dna.Predatory,
                Scavenger:        a.Dna.Scavenger,
                Paranoid:         a.Dna.Paranoid,
                Altruistic:       a.Dna.Altruistic,
                Methodical:       a.Dna.Methodical,
                AgentId:          a.Id,
                Team:             a.Team.ToString(),
                IsWinner:         a.IsAlive && a.Team.ToString() == winningTeam,
                KillCount:        a.KillCount,
                FoodConsumed:     a.FoodConsumed,
                DamageDealt:      a.TotalDamageDealt
            )).ToList();

            var request = new RecordEvolutionRequest(
                SessionId: _sessionId.ToString(),
                Agents:    agentResults);

            await _evolutionClient.RecordSessionOutcomeAsync(request);
        }
        catch
        {
            // Evolution recording is best-effort; do not disrupt session flow
        }
    }

    private async Task GeneratePostMortemAsync(SimulationOutcome outcome, TeamColor? winner)
    {
        var agentSnapshots = _agents!.Select(a => new AgentFinalSnapshotDto(
            Id:             a.Id,
            Team:           a.Team.ToString(),
            Hp:             a.Hp,
            KillCount:      a.KillCount,
            FoodConsumed:   a.FoodConsumed,
            TotalDamageDealt: a.TotalDamageDealt,
            Predatory:      a.Dna.Predatory,
            Scavenger:      a.Dna.Scavenger,
            Paranoid:       a.Dna.Paranoid,
            Altruistic:     a.Dna.Altruistic,
            Methodical:     a.Dna.Methodical,
            SurvivalTurns:  _turn
        )).ToList();

        var narrative = _narrative.GenerateNarrative(
            outcome, winner?.ToString(), _sessionLog, agentSnapshots);

        _dispatcher.Dispatch(new PostMortemReadyAction(
            NarrativeText: narrative,
            WinnerName:    winner?.ToString()));
    }

    private IReadOnlyList<AgentDto> MapAgents() =>
        _agents!.Select(MapAgent).ToList();

    private AgentDto MapAgent(Agent a) => new AgentDto(
        Id:               a.Id,
        Team:             a.Team.ToString(),
        Hp:               a.Hp,
        Hunger:           a.Hunger,
        KillCount:        a.KillCount,
        Predatory:        a.Dna.Predatory,
        Scavenger:        a.Dna.Scavenger,
        Paranoid:         a.Dna.Paranoid,
        Altruistic:       a.Dna.Altruistic,
        Methodical:       a.Dna.Methodical,
        X:                a.Position.X,
        Y:                a.Position.Y,
        IsAlive:          a.IsAlive,
        IsFading:         a.IsFading,
        LastThought:      a.LastThought,
        LastAction:       a.LastAction?.ToString(),
        FoodConsumed:     a.FoodConsumed,
        TotalDamageDealt: a.TotalDamageDealt,
        SurvivalTurns:    _turn
    );

    private IReadOnlyList<FoodNodeDto> MapFoodNodes() =>
        _grid!
            .Where(t => t.Food is not null)
            .Select(t => new FoodNodeDto(t.X, t.Y, t.Food!.SpawnTurn, t.Food.TtlHeartbeats))
            .ToList();

    // Hoisted out of the serialise methods: these run on every heartbeat (up to ~20Hz),
    // and allocating a fresh JsonSerializerOptions per call both churns GC and defeats the
    // serializer's internal per-options metadata cache.
    private static readonly JsonSerializerOptions GridJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private string SerialiseGrid()
    {
        var dto = new GridStateDto(
            TurnNumber: _turn,
            Agents:     MapAgents(),
            FoodNodes:  MapFoodNodes(),
            Rocks:      _grid!
                .Where(t => t.Terrain == TerrainType.Rock)
                .Select(t => new GridCoordinateDto(t.X, t.Y))
                .ToList());

        return JsonSerializer.Serialize(dto, GridJsonOptions);
    }

    private string SerialiseLocalGrid(Agent observer, int radius)
    {
        bool IsWithinRadius(int x, int y) => 
            Math.Abs(x - observer.Position.X) <= radius && Math.Abs(y - observer.Position.Y) <= radius;

        var dto = new GridStateDto(
            TurnNumber: _turn,
            Agents:     _agents!.Where(a => IsWithinRadius(a.Position.X, a.Position.Y)).Select(MapAgent).ToList(),
            FoodNodes:  _grid!.Where(t => t.Food is not null && IsWithinRadius(t.X, t.Y))
                             .Select(t => new FoodNodeDto(t.X, t.Y, t.Food!.SpawnTurn, t.Food.TtlHeartbeats)).ToList(),
            Rocks:      _grid!.Where(t => t.Terrain == TerrainType.Rock && IsWithinRadius(t.X, t.Y))
                             .Select(t => new GridCoordinateDto(t.X, t.Y)).ToList());

        return JsonSerializer.Serialize(dto, GridJsonOptions);
    }

    private static SimulationConfig MapConfig(SimulationConfigDto dto) => new()
    {
        TeamSize              = dto.TeamSize,
        RockDensity           = dto.RockDensity,
        FoodSpawnChance       = dto.FoodSpawnChance,
        FoodTtl               = dto.FoodTtl,
        HungerDecayConstant   = dto.HungerDecayConstant,
        HungerThreshold       = dto.HungerThreshold,
        StarveHpLossPerTurn   = dto.StarveHpLossPerTurn,
        BaseDamage            = dto.BaseDamage,
        HeartbeatMinMs        = dto.HeartbeatMinMs,
        HeartbeatMaxMs        = dto.HeartbeatMaxMs,
        InferenceTimeoutMs    = dto.InferenceTimeoutMs,
        MaxInferredAgentsPerTurn = dto.MaxInferredAgentsPerTurn,
    };
}