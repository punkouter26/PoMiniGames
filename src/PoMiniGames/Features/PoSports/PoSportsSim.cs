using PoShared.Games;

namespace PoMiniGames.Features.PoSports;

/// <summary>
/// Server-authoritative PoSports meet: countdown → sprint → interstitial → hurdles →
/// podium. Pure and tick-driven — no clock, no IO — so the race service can step it at
/// 60 Hz and unit tests can step it deterministically. The stride model mirrors
/// <c>wwwroot/js/posports/physics.js</c> exactly; the constants contract is enforced by
/// <c>PoSportsConstantsSyncTests</c>.
/// </summary>
public sealed class PoSportsSim
{
    public sealed record LaneSetup(string Name, string Character, bool IsAi);

    /// <summary>One lane's mutable state. Position/Speed are settable for test setup.</summary>
    public sealed class LaneState
    {
        public required int Index { get; init; }
        public required string Name { get; init; }
        public required string Character { get; init; }
        public required bool IsAi { get; init; }

        public double Position { get; set; }
        public double Speed { get; set; }
        public double LegTime { get; set; }
        public int SeqProgress { get; set; }
        public double AirborneRemaining { get; set; }
        public double StumbleRemaining { get; set; }
        public double HoldRemaining { get; set; }
        public int NextHurdle { get; set; }
        public bool Finished { get; set; }
        public double SprintSeconds { get; set; } = -1;
        public double HurdlesSeconds { get; set; } = -1;
        public int Placing { get; set; }

        // AI pacing state (unused for human lanes).
        internal double AiKeyTimer;

        internal void ResetForLeg()
        {
            Position = 0; Speed = 0; LegTime = 0; SeqProgress = 0;
            AirborneRemaining = 0; StumbleRemaining = 0; HoldRemaining = 0;
            NextHurdle = 0; Finished = false; AiKeyTimer = 0;
        }
    }

    private const double CountdownSeconds = 3;
    /// <summary>Safety cap per leg — an abandoned human lane can't stall the meet forever.</summary>
    private const double LegTimeoutSeconds = 90;
    private const double StumbleAnimSeconds = 0.7;

    // Server AI cadence: keys per second and wrong-key probability, medium-difficulty
    // typists with per-lane seeded jitter. (Client demo AI lives in ai.js.)
    private const double AiKeysPerSecond = 4.5;
    private const double AiErrorRate = 0.05;
    /// <summary>How far before a hurdle the AI decides to jump, meters.</summary>
    private const double AiJumpLookahead = 1.6;

    private readonly List<LaneState> _lanes;
    private readonly Random _rng;
    private double _phaseClock;

    public PoSportsSim(IReadOnlyList<LaneSetup> setups, int? seed = null)
    {
        _rng = seed is null ? new Random() : new Random(seed.Value);
        _lanes = setups
            .Select((s, i) => new LaneState { Index = i, Name = s.Name, Character = s.Character, IsAi = s.IsAi })
            .ToList();
        Phase = "countdown";
        _phaseClock = CountdownSeconds;
    }

    /// <summary>countdown | sprint | interstitial | hurdles | podium</summary>
    public string Phase { get; private set; }

    /// <summary>Seconds remaining in countdown/interstitial, or the elapsed leg clock.</summary>
    public double Clock => Phase is "countdown" or "interstitial" ? _phaseClock : _lanes.Max(l => l.LegTime);

    public IReadOnlyList<LaneState> Lanes => _lanes;

    public LaneState Lane(int index) => _lanes[index];

    private bool GunFired => Phase is "sprint" or "hurdles";

    private (double Length, IReadOnlyList<double> Hurdles) LegProfile => Phase == "hurdles"
        ? (PoSportsConstants.HurdlesLength, PoSportsConstants.HurdlePositions)
        : (PoSportsConstants.SprintLength, Array.Empty<double>());

    // ── Input ─────────────────────────────────────────────────────────────

    /// <summary>
    /// One sequence key from a lane. <paramref name="step"/> is the ordinal of the key in
    /// that player's layout (0-3) — the client maps physical keys before sending, so the
    /// server never needs to know which letters a layout uses.
    /// </summary>
    public void HandleSequenceKey(int lane, int step)
    {
        if ((uint)lane >= (uint)_lanes.Count || step is < 0 or > 3) return;
        var l = _lanes[lane];
        if (l.Finished) return;

        if (!GunFired)
        {
            // False start: typing before the gun holds the runner off the line.
            l.SeqProgress = 0;
            l.HoldRemaining = PoSportsConstants.FalseStartHold;
            return;
        }

        if (step == l.SeqProgress)
        {
            l.SeqProgress++;
            if (l.SeqProgress == 4)
            {
                l.SeqProgress = 0;
                if (l.HoldRemaining <= 0)
                {
                    var gain = l.AirborneRemaining > 0
                        ? PoSportsConstants.Impulse * PoSportsConstants.JumpDrag
                        : PoSportsConstants.Impulse;
                    l.Speed = Math.Min(PoSportsConstants.MaxSpeed, l.Speed + gain);
                }
            }
        }
        else
        {
            // Out of order — restart the cycle. A wrong key that is the first sequence
            // key counts as step one, matching input.js.
            l.SeqProgress = step == 0 ? 1 : 0;
        }
    }

    /// <summary>The dedicated jump key. Grounded lanes only; airborne presses are ignored.</summary>
    public void HandleJump(int lane)
    {
        if ((uint)lane >= (uint)_lanes.Count) return;
        var l = _lanes[lane];
        if (l.Finished || !GunFired || l.AirborneRemaining > 0) return;
        l.AirborneRemaining = PoSportsConstants.JumpDuration;
    }

    // ── Simulation ────────────────────────────────────────────────────────

    public void Tick(double dt)
    {
        switch (Phase)
        {
            case "countdown":
            case "interstitial":
                _phaseClock -= dt;
                if (_phaseClock <= 0)
                {
                    if (Phase == "interstitial")
                    {
                        foreach (var l in _lanes) l.ResetForLeg();
                        Phase = "hurdles";
                    }
                    else
                    {
                        Phase = "sprint";
                    }
                }
                return;

            case "podium":
                return;
        }

        var (length, hurdles) = LegProfile;
        foreach (var l in _lanes)
        {
            if (l.IsAi && !l.Finished) DriveAi(l, dt, hurdles);
            TickLane(l, dt, hurdles, length);
        }

        var timedOut = _lanes.Max(l => l.LegTime) >= LegTimeoutSeconds;
        if (_lanes.All(l => l.Finished) || timedOut)
        {
            if (timedOut)
            {
                foreach (var l in _lanes.Where(x => !x.Finished))
                {
                    l.Finished = true;
                    l.LegTime = LegTimeoutSeconds;
                }
            }
            CompleteLeg();
        }
    }

    private void TickLane(LaneState l, double dt, IReadOnlyList<double> hurdles, double length)
    {
        if (l.Finished) return;

        l.LegTime += dt;
        l.Speed *= Math.Pow(PoSportsConstants.Decay, dt);
        if (l.AirborneRemaining > 0) l.AirborneRemaining = Math.Max(0, l.AirborneRemaining - dt);
        if (l.StumbleRemaining > 0) l.StumbleRemaining = Math.Max(0, l.StumbleRemaining - dt);
        if (l.HoldRemaining > 0) l.HoldRemaining = Math.Max(0, l.HoldRemaining - dt);

        var prev = l.Position;
        l.Position += l.Speed * dt;

        while (l.NextHurdle < hurdles.Count && l.Position >= hurdles[l.NextHurdle])
        {
            if (l.AirborneRemaining <= 0)
            {
                l.Speed *= PoSportsConstants.StumbleFactor;
                l.LegTime += PoSportsConstants.StumblePenalty;
                l.StumbleRemaining = StumbleAnimSeconds;
            }
            l.NextHurdle++;
        }

        if (prev < length && l.Position >= length)
        {
            l.Position = length;
            l.Finished = true;
        }
    }

    private void DriveAi(LaneState l, double dt, IReadOnlyList<double> hurdles)
    {
        // Jump when a hurdle is inside the lookahead window and the lane is grounded.
        if (l.NextHurdle < hurdles.Count
            && l.AirborneRemaining <= 0
            && hurdles[l.NextHurdle] - l.Position <= AiJumpLookahead
            && l.Speed > 1)
        {
            HandleJump(l.Index);
        }

        l.AiKeyTimer -= dt;
        if (l.AiKeyTimer > 0) return;
        // Jittered inter-key gap around the target cadence.
        l.AiKeyTimer = (1 / AiKeysPerSecond) * (0.8 + 0.4 * _rng.NextDouble());
        var step = _rng.NextDouble() < AiErrorRate
            ? _rng.Next(4)          // fat-fingered key, possibly correct by luck
            : l.SeqProgress;        // the right next key
        HandleSequenceKey(l.Index, step);
    }

    private void CompleteLeg()
    {
        if (Phase == "sprint")
        {
            foreach (var l in _lanes) l.SprintSeconds = l.LegTime;
            Phase = "interstitial";
            _phaseClock = PoSportsConstants.InterstitialSeconds;
        }
        else
        {
            foreach (var l in _lanes) l.HurdlesSeconds = l.LegTime;
            EnterPodium();
        }
    }

    private void EnterPodium()
    {
        Phase = "podium";
        var ranked = _lanes
            .OrderBy(l => l.SprintSeconds + l.HurdlesSeconds)
            .ThenBy(l => l.Index)
            .ToList();
        for (var i = 0; i < ranked.Count; i++) ranked[i].Placing = i + 1;
    }

    // ── Snapshots ─────────────────────────────────────────────────────────

    public PoSportsSnapshot Snapshot() => new(
        Phase,
        Clock,
        _lanes.Select(l => new PoSportsLaneState(
            l.Index, l.Name, l.Character, l.IsAi,
            l.Position, l.Speed, l.SeqProgress,
            l.AirborneRemaining > 0, l.StumbleRemaining > 0,
            l.LegTime, l.Finished,
            l.SprintSeconds, l.HurdlesSeconds, l.Placing)).ToList());

    // ── Test / operational hooks ──────────────────────────────────────────

    /// <summary>Fire the gun immediately (tests; demo fast-start).</summary>
    public void SkipCountdown()
    {
        if (Phase == "countdown") Phase = "sprint";
    }

    /// <summary>Jump straight to the hurdles leg with fresh lanes (tests).</summary>
    public void AdvanceToHurdlesLeg()
    {
        foreach (var l in _lanes) l.ResetForLeg();
        Phase = "hurdles";
    }

    /// <summary>Finish the current leg for every lane at its current LegTime (tests; ops skip).</summary>
    public void ForceLegFinish(bool sprint)
    {
        foreach (var l in _lanes) l.Finished = true;
        Phase = sprint ? "sprint" : "hurdles";
        CompleteLeg();
    }

    /// <summary>Set both legs' results outright and rank the podium (tests).</summary>
    public void ForceMeetResult(double[] sprintSeconds, double[] hurdlesSeconds)
    {
        for (var i = 0; i < _lanes.Count; i++)
        {
            _lanes[i].SprintSeconds = sprintSeconds[i];
            _lanes[i].HurdlesSeconds = hurdlesSeconds[i];
            _lanes[i].Finished = true;
        }
        EnterPodium();
    }
}
