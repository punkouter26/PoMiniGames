namespace PoMiniGamesClient.Games.PoSurvive.Services;

using System.Text.Json;
using PoMiniGamesClient.Services;
using PoMiniGames.Application.Simulation;
using PoMiniGamesClient.Games.PoSurvive.Store;
using PoMiniGames.Domain.Entities.Simulation;
using PoMiniGames.Domain.Enums.Simulation;
using PoMiniGames.Domain.ValueObjects.Simulation;
using PoShared.Simulation.Interfaces;
using PoShared.Simulation.Models;
using PoShared.Simulation.Constants;

/// <summary>
/// Holds the mutable domain model for a running simulation and orchestrates heartbeat
/// ticks on a timer. View state is pushed to <see cref="Sink"/> after each tick.
/// </summary>
public sealed class SimulationOrchestrator : IDisposable
{
    private const int MinPerAgentInferenceMs = 1_200;
    private const int MaxPerAgentInferenceMs = 10_000;
    private const int MinTurnInferenceBudgetMs = 6_000;
    private const int MaxTurnInferenceBudgetMs = 20_000;

    /// <summary>Upper bound on the per-session inference memo (see <c>_inferenceCache</c>).</summary>
    private const int MaxInferenceCacheEntries = 512;

    /// <summary>
    /// Where turn output goes. SurviveStore assigns itself here in its constructor —
    /// property injection rather than a constructor parameter so the store can depend on
    /// the orchestrator without the two forming a DI cycle.
    /// </summary>
    public ISimulationSink? Sink { get; set; }

    private readonly IInferenceService _inference;
    private readonly GridService _gridSvc;
    private readonly SimulationEngine _engine;
    private readonly NarrativeService _narrative;
    private readonly EvolutionClientService _evolutionClient;

    // ─── Mutable runtime state ────────────────────────────────────────────
    private GridTile[]? _grid;
    private List<Agent>? _agents;
    private SimulationConfig? _config;
    private Guid _sessionId;
    private DateTimeOffset _startedAt;
    private int _turn;
    private int _inferenceRoundRobinOffset;
    private bool _isMock;
    private readonly Random _rng = new();

    /// <summary>
    /// Turn each agent died on, keyed by agent id. Every agent used to report
    /// <c>SurvivalTurns = _turn</c>, so a corpse's "turns survived" kept climbing for the
    /// rest of the match — most visibly on the champion chip's hourglass, which counted
    /// up long after the champion fell.
    /// </summary>
    private readonly Dictionary<string, int> _deathTurn = [];

    /// <summary>
    /// Interval to start the next session's heartbeat at. <see cref="SetSpeed"/> used to
    /// no-op whenever <c>_timer</c> was null — which is exactly the state between Reset
    /// and Start — so a speed chosen before launch was silently dropped and
    /// <see cref="Initialize"/> then started the timer at HeartbeatMaxMs regardless.
    /// </summary>
    private int _pendingIntervalMs = SimulationDefaults.DefaultHeartbeatMs;

    // HeartbeatEvents accumulated for the current session
    private readonly List<HeartbeatEventDto> _sessionLog = [];
    // Concurrent because a turn's per-agent calls now run in parallel. WASM is
    // single-threaded today so a plain Dictionary would survive, but the memo is written
    // after an await and that is exactly the shape that stops being safe the moment it isn't.
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, (string Thought, string Action)> _inferenceCache = new();

    private System.Timers.Timer? _timer;
    private bool _ticking;
    private bool _stopped;
    private bool _paused;
    private readonly object _stateLock = new();

    public SimulationOrchestrator(
        IInferenceService inference,
        GridService gridSvc,
        SimulationEngine engine,
        NarrativeService narrative,
        EvolutionClientService evolutionClient)
    {
        _inference = inference;
        _gridSvc = gridSvc;
        _engine = engine;
        _narrative = narrative;
        _evolutionClient = evolutionClient;
    }

    // ─── Public API ───────────────────────────────────────────────────────

    /// <summary>
    /// Builds the grid, places agents, and starts the heartbeat timer.
    /// </summary>
    /// <param name="initialSpeedMs">
    /// Turn interval to run at. Optional: null keeps whatever the last <see cref="SetSpeed"/>
    /// asked for. This parameter exists because the old code started the timer at
    /// <c>config.HeartbeatMaxMs</c> (2000 ms) no matter what the UI's speed chips said, so
    /// the "Balanced" chip rendered active while the sim ticked at the slowest setting, and
    /// the kiosk demo's 250 ms request was dropped entirely.
    /// </param>
    public void Initialize(SimulationConfigDto configDto, bool isMockProvider, int? initialSpeedMs = null)
    {
        _config = MapConfig(configDto);
        _sessionId = Guid.NewGuid();
        _startedAt = DateTimeOffset.UtcNow;
        _turn = 0;
        _inferenceRoundRobinOffset = 0;
        _isMock = isMockProvider;
        _sessionLog.Clear();
        _deathTurn.Clear();

        // Cleared per session, not just per Reset: the cache keys carry HP/hunger/local
        // grid, all of which repeat across sessions, so a new battle could otherwise
        // replay the previous battle's thoughts.
        _inferenceCache.Clear();

        if (initialSpeedMs is { } requested)
            _pendingIntervalMs = ClampInterval(requested);

        _grid = _gridSvc.GenerateGrid(_config, _rng);
        _agents = _gridSvc.CreateAgents(_config, _rng);
        _gridSvc.PlaceAgents(_grid, _agents, _rng);

        // Build rock list for state (immutable for this session)
        var rocks = _grid
            .Where(t => t.Terrain == TerrainType.Rock)
            .Select(t => new GridCoordinateDto(t.X, t.Y))
            .ToList();

        // Fire-and-forget: Initialize is the synchronous entry point off a button click,
        // and the sink's work (open session log, start ambient audio) must not block the
        // first heartbeat. This matches how Fluxor dispatched into the async effects.
        _ = Sink?.OnInitialisedAsync(new SimulationInitialised(
            SessionId: _sessionId,
            Agents: MapAgents(),
            Rocks: rocks,
            Config: configDto,
            IsMockProvider: isMockProvider));

        StartTimer(_pendingIntervalMs);
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

            // Record the turn each casualty fell on, and retire the one-shot death
            // animation flag for anyone who fell on an EARLIER turn. IsFading was set
            // once and never cleared, so it was a permanent "is dead" flag masquerading
            // as a transient effect.
            foreach (var deadId in result.DiedThisTurn)
                _deathTurn.TryAdd(deadId, _turn);

            foreach (var agent in _agents)
            {
                if (agent.IsFading && _deathTurn.TryGetValue(agent.Id, out var fell) && fell < _turn)
                    agent.IsFading = false;
            }

            // 3. Build console entries.
            //
            // Alive agents plus this turn's casualties — NOT every agent. The engine only
            // refreshes LastAction/LastThought for the living, so including corpses
            // re-emitted their final thought every turn for the rest of the match: the
            // tactical log filled with duplicate corpse rows, ActionMixChart counted the
            // dead as still acting, and AudioCues replayed a combat sting per corpse per
            // turn. Casualties are included on their death turn so the kill still shows up
            // in the log exactly once.
            var reporting = _agents
                .Where(a => a.IsAlive || (_deathTurn.TryGetValue(a.Id, out var t) && t == _turn))
                .ToList();

            var newEntries = reporting
                .Select(a => new ConsoleEntry(
                    TurnNumber: _turn,
                    AgentId: a.Id,
                    Team: a.Team.ToString(),
                    Thought: a.LastThought ?? "(thinking…)",
                    Action: a.LastAction?.ToString() ?? "Idle"))
                .ToList();

            // 4. Build heartbeat DTOs for session log (same reporting set as the console)
            var gridJson = SerialiseGrid();
            var heartbeats = reporting.Select(a =>
            {
                var before = hpBefore.TryGetValue(a.Id, out var b) ? b : (Hp: a.Hp, Hunger: a.Hunger);
                return new HeartbeatEventDto(
                    SessionId: _sessionId,
                    TurnNumber: _turn,
                    AgentId: a.Id,
                    Team: a.Team.ToString(),
                    ThoughtText: a.LastThought ?? "",
                    ActionTaken: a.LastAction?.ToString() ?? "Idle",
                    HpBefore: before.Hp,
                    HpAfter: a.Hp,
                    HungerBefore: before.Hunger,
                    HungerAfter: a.Hunger,
                    GridSnapshot: gridJson);
            }).ToList();

            _sessionLog.AddRange(heartbeats);

            // 5. Per-death notifications (for audio)
            foreach (var deadId in result.DiedThisTurn)
            {
                var deadAgent = _agents.FirstOrDefault(a => a.Id == deadId);
                if (deadAgent is not null && Sink is not null)
                    await Sink.OnAgentDiedAsync(new AgentDied(deadId, deadAgent.Team.ToString()));
            }

            // 6. Publish the completed turn
            string? outcome = result.Outcome?.ToString();
            string? winnerTeam = result.WinningTeam?.ToString();

            if (Sink is not null)
                await Sink.OnHeartbeatAsync(new HeartbeatCompleted(
                    TurnNumber: _turn,
                    Agents: MapAgents(),
                    FoodNodes: MapFoodNodes(),
                    NewEntries: newEntries,
                    Outcome: outcome,
                    WinningTeam: winnerTeam,
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

    /// <summary>
    /// Updates the heartbeat timer interval. Recorded even when no timer exists yet, so a
    /// speed picked before the battle starts is applied at launch instead of dropped.
    /// </summary>
    public void SetSpeed(int ms)
    {
        _pendingIntervalMs = ClampInterval(ms);
        if (_timer is not null)
            _timer.Interval = _pendingIntervalMs;
    }

    private static int ClampInterval(int ms) => Math.Clamp(ms, 50, 5000);

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
            _grid = null;
            _agents = null;
            _config = null;
            _sessionLog.Clear();
            _inferenceCache.Clear();
            _deathTurn.Clear();
            _turn = 0;
            _paused = false;
            _inferenceRoundRobinOffset = 0;
            // _pendingIntervalMs is deliberately NOT reset — a speed the player chose
            // should survive "New battle", the same way OnInitialisedAsync carries it.
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
        var dict = new Dictionary<string, AgentAction>();
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

        // ── Mock / degraded: resolved inline, no I/O, no budget to spend ──────────
        if (_isMock)
        {
            foreach (var agent in agentsToInfer)
            {
                // Two very different situations arrive here as one flag.
                //
                // A registered MockInferenceService means the app was deliberately built
                // without a real provider (Inference:UseMock). That service is synchronous,
                // deterministic and scripted per dominant trait — exactly what this branch
                // wants — yet it was never once invoked, because this short-circuit sat in
                // front of it and substituted the trait-hash table. Every agent's "thought"
                // read "Inference mock. Standing by."
                //
                // Degraded mode is the other case: a real provider exists but could not be
                // brought up. Scripted prose would misrepresent that, so it keeps the
                // fallback table and the honest wording.
                if (_inference is MockInferenceService scripted)
                {
                    var mockResult = await scripted.InferAsync(SerialiseLocalGrid(agent, 3), ToDna(agent), CancellationToken.None);
                    agent.LastThought = mockResult.Thought;
                    dict[agent.Id] = Enum.TryParse<AgentAction>(mockResult.Action, true, out var mockAction)
                        ? mockAction
                        : AgentAction.Idle;
                    continue;
                }

                var fallback = GetFallbackInference(agent, "unavailable", preferReuseLastAction: false);
                agent.LastThought = fallback.Thought;
                dict[agent.Id] = fallback.Action;
            }
        }
        else
        {
            // ── Real inference: all of this turn's agents CONCURRENTLY ─────────────
            //
            // This loop used to be sequential, and it sliced the turn budget by the number
            // of agents still to go: with three agents and a 15 s budget each got 5 s. A
            // gpt-4o-mini round trip measures ~4.6 s, so the slice expired a few hundred
            // milliseconds before the answer arrived and nearly every agent logged
            // "Inference timed out after 4986 ms" — a real provider, answering correctly,
            // reported as broken. Sequential also made a turn cost the SUM of the latencies
            // (~14 s/turn), which is why the board sat on turn 0 while the header said
            // "AI online".
            //
            // Per-agent inference is independent, so it fans out: a turn now costs the
            // slowest single call rather than their sum, and each agent gets the whole turn
            // budget instead of a fraction of it. The local WebLLM path is unaffected in
            // behaviour — inferenceWorkerBridge.js already serialises requests through its
            // own queue, so concurrent callers there simply queue.
            var inferred = await Task.WhenAll(agentsToInfer.Select(agent =>
                InferOneAsync(agent, turnBudgetMs)));

            foreach (var (agent, thought, action) in inferred)
            {
                agent.LastThought = thought;
                dict[agent.Id] = action;
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

    /// <summary>
    /// One agent's inference attempt. Returns the thought/action to apply rather than
    /// mutating the agent, so the concurrent callers in <see cref="InferActionsAsync"/> only
    /// touch shared state after every call has settled.
    /// </summary>
    private async Task<(Agent Agent, string Thought, AgentAction Action)> InferOneAsync(
        Agent agent, int budgetMs)
    {
        var localGridJson = SerialiseLocalGrid(agent, 3);
        // The projection already carries this agent's hp/hunger under "self", so it is the
        // whole key. The old prefix formatted a float with the ambient culture, which would
        // have keyed differently under a comma-decimal locale.
        var cacheKey = localGridJson;

        if (_inferenceCache.TryGetValue(cacheKey, out var cached))
        {
            return (agent, cached.Thought,
                Enum.TryParse<AgentAction>(cached.Action, true, out var hit) ? hit : AgentAction.Idle);
        }

        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(budgetMs));
        using var inferScope = (_inference as WebLlmInferenceService)
            ?.BeginDiagnosticsScope(_turn, agent.Id, agent.Team.ToString());

        try
        {
            var result = await _inference.InferAsync(localGridJson, ToDna(agent), cts.Token);

            // Bounded: the cache is a per-session memo, not a store. Nothing evicted it
            // before, so a long match grew it without limit.
            if (_inferenceCache.Count >= MaxInferenceCacheEntries)
                _inferenceCache.Clear();
            _inferenceCache[cacheKey] = (result.Thought, result.Action);

            return (agent, result.Thought,
                Enum.TryParse<AgentAction>(result.Action, true, out var parsed) ? parsed : AgentAction.Idle);
        }
        catch (OperationCanceledException)
        {
            var fallback = GetFallbackInference(agent, "timeout");
            return (agent, $"Inference timed out after {budgetMs} ms. {fallback.Thought}", fallback.Action);
        }
        catch
        {
            var fallback = GetFallbackInference(agent, "unavailable");
            return (agent, fallback.Thought, fallback.Action);
        }
    }

    private static PersonalityDnaDto ToDna(Agent agent) => new(
        agent.Dna.Predatory,
        agent.Dna.Scavenger,
        agent.Dna.Paranoid,
        agent.Dna.Altruistic,
        agent.Dna.Methodical);

    private (string Thought, AgentAction Action) GetFallbackInference(
        Agent agent,
        string reason,
        bool preferReuseLastAction = true)
    {
        // "deferred" is not a failure: it means this agent wasn't in this turn's round-robin
        // slice, so it repeats its standing order. Wording it like the error cases
        // ("Inference deferred. Standing by.") made a normal, expected turn look broken —
        // and with MaxInferredAgentsPerTurn below the roster size, that was most of the log.
        var thought = reason == "deferred"
            ? "No new orders this turn — continuing last manoeuvre."
            : $"Inference {reason.Replace('_', ' ')}. Standing by.";

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
                Predatory: a.Dna.Predatory,
                Scavenger: a.Dna.Scavenger,
                Paranoid: a.Dna.Paranoid,
                Altruistic: a.Dna.Altruistic,
                Methodical: a.Dna.Methodical,
                AgentId: a.Id,
                Team: a.Team.ToString(),
                IsWinner: a.IsAlive && a.Team.ToString() == winningTeam,
                KillCount: a.KillCount,
                FoodConsumed: a.FoodConsumed,
                DamageDealt: a.TotalDamageDealt
            )).ToList();

            var request = new RecordEvolutionRequest(
                SessionId: _sessionId.ToString(),
                Agents: agentResults);

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
            Id: a.Id,
            Team: a.Team.ToString(),
            Hp: a.Hp,
            KillCount: a.KillCount,
            FoodConsumed: a.FoodConsumed,
            TotalDamageDealt: a.TotalDamageDealt,
            Predatory: a.Dna.Predatory,
            Scavenger: a.Dna.Scavenger,
            Paranoid: a.Dna.Paranoid,
            Altruistic: a.Dna.Altruistic,
            Methodical: a.Dna.Methodical,
            SurvivalTurns: SurvivalTurnsOf(a)
        )).ToList();

        var narrative = _narrative.GenerateNarrative(
            outcome, winner?.ToString(), _sessionLog, agentSnapshots);

        if (Sink is not null)
            await Sink.OnPostMortemAsync(new PostMortemReady(
                NarrativeText: narrative,
                WinnerName: winner?.ToString()));
    }

    private IReadOnlyList<AgentDto> MapAgents() =>
        _agents!.Select(MapAgent).ToList();

    private AgentDto MapAgent(Agent a) => new AgentDto(
        Id: a.Id,
        Team: a.Team.ToString(),
        Hp: a.Hp,
        Hunger: a.Hunger,
        KillCount: a.KillCount,
        Predatory: a.Dna.Predatory,
        Scavenger: a.Dna.Scavenger,
        Paranoid: a.Dna.Paranoid,
        Altruistic: a.Dna.Altruistic,
        Methodical: a.Dna.Methodical,
        X: a.Position.X,
        Y: a.Position.Y,
        IsAlive: a.IsAlive,
        IsFading: a.IsFading,
        LastThought: a.LastThought,
        LastAction: a.LastAction?.ToString(),
        FoodConsumed: a.FoodConsumed,
        TotalDamageDealt: a.TotalDamageDealt,
        SurvivalTurns: SurvivalTurnsOf(a)
    );

    /// <summary>
    /// Turns this agent was actually in the match: the current turn while it lives, and
    /// the turn it fell on once it doesn't. Previously every agent reported the current
    /// turn, so corpses kept accruing survival time.
    /// </summary>
    private int SurvivalTurnsOf(Agent a)
        => _deathTurn.TryGetValue(a.Id, out var fell) ? fell : _turn;

    private IReadOnlyList<FoodNodeDto> MapFoodNodes() =>
        _grid!
            .Where(t => t.Food is not null)
            .Select(t => new FoodNodeDto(t.X, t.Y, t.Food!.SpawnTurn, t.Food.TtlHeartbeats))
            .ToList();

    // GridStateDto is serialised using the source-generated ApiJsonContext (trim-safe, no reflection).

    private string SerialiseGrid()
    {
        var dto = new GridStateDto(
            TurnNumber: _turn,
            Agents: MapAgents(),
            FoodNodes: MapFoodNodes(),
            Rocks: _grid!
                .Where(t => t.Terrain == TerrainType.Rock)
                .Select(t => new GridCoordinateDto(t.X, t.Y))
                .ToList());

        return JsonSerializer.Serialize(dto, ApiJsonContext.Default.GridStateDto);
    }

    private string SerialiseLocalGrid(Agent observer, int radius)
    {
        bool IsWithinRadius(int x, int y) =>
            Math.Abs(x - observer.Position.X) <= radius && Math.Abs(y - observer.Position.Y) <= radius;

        // Hand-built rather than a serialised GridStateDto, for two reasons.
        //
        // 1. STABILITY. This projection doubles as the inference cache key. GridStateDto
        //    carries TurnNumber, and its AgentDto carries SurvivalTurns — both advance
        //    every turn, so every key was unique: the cache could never hit while still
        //    growing on every turn of every match.
        // 2. COST. The full DTO ships five DNA floats, kill/food/damage counters and
        //    fading flags per agent. The model is being asked "what should I do from
        //    here"; position, health and hunger answer that. The personality arrives
        //    separately as the dna argument. Smaller prompt, fewer tokens per call —
        //    which is the difference that matters on the metered cloud path.
        //
        // StringBuilder, not an anonymous type: this project serialises through the
        // source-generated ApiJsonContext precisely so nothing depends on reflection,
        // and a one-off shape doesn't earn a context entry.
        var sb = new System.Text.StringBuilder(256);
        sb.Append("{\"self\":");
        AppendAgent(sb, observer);
        sb.Append(",\"agents\":[");
        var first = true;
        foreach (var a in _agents!.Where(a => a.IsAlive
                                           && a.Id != observer.Id
                                           && IsWithinRadius(a.Position.X, a.Position.Y)))
        {
            if (!first) sb.Append(',');
            first = false;
            AppendAgent(sb, a);
        }
        sb.Append("],\"food\":[");
        first = true;
        foreach (var t in _grid!.Where(t => t.Food is not null && IsWithinRadius(t.X, t.Y)))
        {
            if (!first) sb.Append(',');
            first = false;
            AppendPoint(sb, t.X, t.Y);
        }
        sb.Append("],\"rocks\":[");
        first = true;
        foreach (var t in _grid!.Where(t => t.Terrain == TerrainType.Rock && IsWithinRadius(t.X, t.Y)))
        {
            if (!first) sb.Append(',');
            first = false;
            AppendPoint(sb, t.X, t.Y);
        }
        sb.Append("]}");
        return sb.ToString();

        static void AppendAgent(System.Text.StringBuilder sb, Agent a) => sb
            .Append("{\"id\":\"").Append(a.Id)
            .Append("\",\"team\":\"").Append(a.Team)
            .Append("\",\"x\":").Append(a.Position.X.ToString(System.Globalization.CultureInfo.InvariantCulture))
            .Append(",\"y\":").Append(a.Position.Y.ToString(System.Globalization.CultureInfo.InvariantCulture))
            .Append(",\"hp\":").Append(a.Hp.ToString(System.Globalization.CultureInfo.InvariantCulture))
            .Append(",\"hunger\":").Append(a.Hunger.ToString("F2", System.Globalization.CultureInfo.InvariantCulture))
            .Append('}');

        static void AppendPoint(System.Text.StringBuilder sb, int x, int y) => sb
            .Append("{\"x\":").Append(x.ToString(System.Globalization.CultureInfo.InvariantCulture))
            .Append(",\"y\":").Append(y.ToString(System.Globalization.CultureInfo.InvariantCulture))
            .Append('}');
    }

    private static SimulationConfig MapConfig(SimulationConfigDto dto) => new()
    {
        TeamSize = dto.TeamSize,
        RockDensity = dto.RockDensity,
        FoodSpawnChance = dto.FoodSpawnChance,
        FoodTtl = dto.FoodTtl,
        HungerDecayConstant = dto.HungerDecayConstant,
        HungerThreshold = dto.HungerThreshold,
        StarveHpLossPerTurn = dto.StarveHpLossPerTurn,
        BaseDamage = dto.BaseDamage,
        HeartbeatMinMs = dto.HeartbeatMinMs,
        HeartbeatMaxMs = dto.HeartbeatMaxMs,
        InferenceTimeoutMs = dto.InferenceTimeoutMs,
        MaxInferredAgentsPerTurn = dto.MaxInferredAgentsPerTurn,
        MaxTurns = dto.MaxTurns,
    };
}
