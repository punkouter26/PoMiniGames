// ai.js — CPU fighter. Emits the same intent shape as KeyboardController so the game
// treats human and CPU fighters identically.

import { PERSONALITIES } from './personalities.js';
//
// Frame-data awareness: the AI receives the opponent's current attack phase
// (windup/active/recover) and the recovery window of each of its own attacks.
// It will:
//   • block during opponent windup with probability by difficulty, but only
//     once the windup has been visible for this rung's reaction floor — so a
//     jab is never reactively blocked and a held coil always is
//   • throw its fastest attack when the opponent is in active/recover (whiff punish)
//   • occasionally commit to a blocked attack then cancel into block (bait)
//   • back off after taking quick consecutive hits (anti-stunlock)
//   • occasionally wind up a held CHARGE attack while the opponent is stuck
//     in hitstun (the coil pose is the player's tell to block the release)
//   • load a full coil at an opponent who has GASSED their energy bar out —
//     the punish for spending the whole bar on offence, and the reason the
//     guard is worth learning, since blocking is what refills it
//
// Three layers decide what the CPU does on a tick, in priority order:
//   1. the signature PHRASE (personalities.js `aiPatterns`) — a fixed script
//      that owns the fighter for a couple of seconds when it opens;
//   2. the frame-data reactions below — block the wind-up, punish the whiff,
//      coil at a gassed opponent — gated by the rung's reaction time;
//   3. the signature FOOTWORK (personalities.js `footwork`) — a fixed cycle of
//      move/orbit beats that fills everything else, which is most of a round.
// Layers 1 and 3 are the learnable ones: neither is randomised, and layer 3
// runs on an uninterrupted clock so the rhythm is countable. Layer 2 is the
// difficulty dial. Before layer 3 existed all fifteen presidents moved
// identically in neutral and only differed for the few seconds a phrase was
// running — see the `footwork` doc block in personalities.js.
//
// In-match adaptation: the AI also reads the opponent's habits over a rolling
// ~8-second window and shifts its weights —
//   • turtles (blocking a big share of in-range time) draw more kicks, because
//     the guard capsules only cover the forearms so kicks to the legs land
//     through a standing block, plus more feint-baits
//   • spammers (high attack rate) get blocked and whiff-punished more often
// Adaptation strength scales with the rung, so a level-2 president barely
// adjusts while a level-9 one counters your gameplan within a few exchanges.

// Fifteen numeric skill rungs for the 1-player presidents ladder. Level 1 is
// gentle but no longer a statue; level 15 is a wall (superhuman reactions,
// near-perfect blocking and whiff punishing, relentless).
// `aggro` scales how often the AI chooses to attack at all. `comboP` is the
// chance a committed punch is pre-planned as a punch→kick cancel string —
// only rungs 5+ know the cancel table exists. The top five rungs (LBJ-FDR)
// tighten reactions past human reflexes and lean on more baits and combos
// rather than just faster reads — diminishing returns on raw reactionMs.
//
// ── 2026-09-12 rebalance (user request: "more difficult, each level harder
// than the last, force the player to learn to block") ─────────────────────
// Two problems with the old curve. First, rungs 1-4 were not a difficulty ramp
// so much as a tutorial that lasted four fights: at aggro 0.35 / blockP 0.03 a
// rung-1 president mostly stood there, and a player could clear the first third
// of the ladder mashing punch without ever pressing block. Second, the curve
// went nearly flat above rung 10 — 11 through 15 differed by ~35 ms of reaction
// and nothing else, so the last five fights felt like the same opponent.
//
// The floor is raised (rung 1 now guards and punishes a little, which is what
// teaches the block button exists) and the top is pushed out along the axes
// that still have room — aggro, comboP, baitP, and the two new columns:
//
//   chargeP  — how readily this rung commits to a HELD coil instead of a tap.
//              This is the column that does the forcing: a coil is the one
//              swing a player genuinely cannot trade with, so the guard is the
//              only answer. It replaces the old formula-derived value.
//   punishGas — chance per opening to load a full coil at an opponent who has
//              gassed their energy bar out. Spending the bar on offence and
//              then standing there is the mistake this punishes, and blocking
//              is what refills it — so the counter and the lesson agree.
//
// ── 2026-09-13 low-rung pass (user request: "the first 6 presidents are too
//    easy to beat, make them 50% more difficult") ───────────────────────────
// Rungs 1-6 are Trump through Bush Sr., i.e. the whole first third of the
// ladder, and they were still losing to a player who had learned nothing. The
// 2026-09-12 pass had lifted the floor off zero but left the bottom six sitting
// well under half the sharpness of the middle of the ladder.
//
// The lift is NOT ×1.5 on every column, and it is worth writing down why, since
// that is the obvious reading of the request and it does not survive contact
// with the table. Difficulty here is the PRODUCT of the columns, not their sum:
// a president that blocks more AND punishes more AND reacts faster AND coils
// more often compounds, so ×1.5 on each of six independent columns is nowhere
// near 50% harder — it is several times harder. Worse, ×1.5 on rung 6's blockP
// lands at 0.81, which is old rung 10, and rungs 7-15 would then have to fit
// into the 0.81-0.97 band and become indistinguishable from each other. The
// request was to fix the bottom of the ladder, not to flatten the top of it.
//
// So the lift is tapered: about +60% on rung 1 falling to about +20% by rung 6,
// per column, which multiplies out to roughly "half again as hard" as a fight.
// Concretely a rung-1 president now guards about one swing in six instead of
// one in ten, punishes a whiff 14% of the time instead of 8%, reacts in 560 ms
// instead of 700 ms, and coils at a gassed opponent 24% of the time instead of
// 15% — it still cannot read a jab (see reactFloor) and still spends most of a
// round not attacking, but it is a fight rather than a heavy bag.
//
// Rungs 7-10 are nudged up a few points purely to keep every column strictly
// monotone after rung 6 moved; 11-15 are untouched except where a column had to
// step around the rungs below it. The endpoints of the ladder are the same
// fighter they were.
//
// comboP also starts earlier now: rungs 2-4 get a small cancel-string share
// where they previously had none. That column is the sharpest single difficulty
// jump in the table — a punch that cancels into a kick beats the guard, because
// the guard capsules do not cover the legs — so handing the early ladder a
// little of it is most of what makes rungs 2-4 feel like opponents. Rung 1 is
// deliberately still zero: the first fight stays the one that teaches.
const LEVELS = [
  /*  1 */ { reactionMs: 560, blockP: 0.16, baitP: 0.02, punishP: 0.14, aggro: 0.72, comboP: 0.00, chargeP: 0.18, punishGas: 0.24 },
  /*  2 */ { reactionMs: 490, blockP: 0.26, baitP: 0.04, punishP: 0.24, aggro: 0.81, comboP: 0.06, chargeP: 0.23, punishGas: 0.33 },
  /*  3 */ { reactionMs: 428, blockP: 0.36, baitP: 0.06, punishP: 0.35, aggro: 0.89, comboP: 0.13, chargeP: 0.28, punishGas: 0.42 },
  /*  4 */ { reactionMs: 375, blockP: 0.46, baitP: 0.08, punishP: 0.46, aggro: 0.97, comboP: 0.20, chargeP: 0.33, punishGas: 0.50 },
  /*  5 */ { reactionMs: 328, blockP: 0.56, baitP: 0.10, punishP: 0.56, aggro: 1.04, comboP: 0.28, chargeP: 0.38, punishGas: 0.58 },
  /*  6 */ { reactionMs: 288, blockP: 0.65, baitP: 0.13, punishP: 0.65, aggro: 1.10, comboP: 0.36, chargeP: 0.42, punishGas: 0.66 },
  /*  7 */ { reactionMs: 252, blockP: 0.72, baitP: 0.16, punishP: 0.73, aggro: 1.16, comboP: 0.44, chargeP: 0.45, punishGas: 0.70 },
  /*  8 */ { reactionMs: 220, blockP: 0.78, baitP: 0.19, punishP: 0.79, aggro: 1.21, comboP: 0.52, chargeP: 0.48, punishGas: 0.75 },
  /*  9 */ { reactionMs: 192, blockP: 0.83, baitP: 0.22, punishP: 0.84, aggro: 1.26, comboP: 0.58, chargeP: 0.52, punishGas: 0.79 },
  /* 10 */ { reactionMs: 166, blockP: 0.87, baitP: 0.25, punishP: 0.88, aggro: 1.31, comboP: 0.64, chargeP: 0.55, punishGas: 0.83 },
  /* 11 */ { reactionMs: 143, blockP: 0.90, baitP: 0.28, punishP: 0.91, aggro: 1.35, comboP: 0.70, chargeP: 0.58, punishGas: 0.87 },
  /* 12 */ { reactionMs: 126, blockP: 0.92, baitP: 0.31, punishP: 0.94, aggro: 1.39, comboP: 0.75, chargeP: 0.61, punishGas: 0.90 },
  /* 13 */ { reactionMs: 113, blockP: 0.94, baitP: 0.34, punishP: 0.96, aggro: 1.43, comboP: 0.80, chargeP: 0.63, punishGas: 0.93 },
  /* 14 */ { reactionMs: 103, blockP: 0.96, baitP: 0.38, punishP: 0.98, aggro: 1.47, comboP: 0.85, chargeP: 0.66, punishGas: 0.96 },
  /* 15 */ { reactionMs:  95, blockP: 0.97, baitP: 0.42, punishP: 1.00, aggro: 1.50, comboP: 0.90, chargeP: 0.68, punishGas: 0.98 },
];

// Top-of-the-ladder rung count: rung index doubles as the CPU difficulty level
// (index + 1 → 1..15). Kept in sync with Roster.Length in PoBrawlPage.razor.
export const MAX_RUNG = 15;

// Habit-tracker tuning. The rolling window is an exponential decay so recent
// behavior dominates; thresholds are the point past which a habit is "read".
const HABIT_TAU = 8;          // seconds of memory
const TURTLE_THRESHOLD = 0.35; // fraction of in-range time spent blocking
const SPAM_THRESHOLD = 0.5;    // opponent attacks per second

// Longest a footwork signature may keep a fighter out of range before the AI
// overrides it and closes. Every dance in personalities.js closes on its own
// inside a second, but the clamp is not about them: a fighter parked at the far
// rope by its own rhythm is not a pattern to read, it is a stalemate the player
// cannot end either. One second is long enough that the beat still shows.
const FOOT_STALL_MAX = 1.0;

// Legacy string difficulties (used by demo / 2p fallbacks) map onto rungs.
const NAMED_LEVELS = { easy: 2, medium: 5, hard: 8 };

export class AiController {
  /** difficulty: 1-15 rung number, or 'easy' | 'medium' | 'hard'.
   *  charId: optional president id used to apply personality modifiers. */
  constructor(difficulty, rng = null, charId = null) {
    const level = typeof difficulty === 'number'
      ? Math.max(1, Math.min(MAX_RUNG, Math.round(difficulty)))
      : (NAMED_LEVELS[difficulty] || NAMED_LEVELS.medium);
    const p = LEVELS[level - 1];
    this.level = level;
    this.reactionMs = p.reactionMs;
    this.blockP = p.blockP;
    this.baitP = p.baitP;
    this.punishP = p.punishP;
    this.aggro = p.aggro;
    this.comboP = p.comboP;
    this.punishGasP = p.punishGas;
    // How hard the habit reads bend the weights: level 1 ≈ 0.07, level 15 = 1.
    this.adapt = level / MAX_RUNG;

    // ── Rung-scaled pattern delivery ──────────────────────────────────
    // The phrases in personalities.js are written at their LOW-rung tempo; the
    // rung decides how fast they are executed and how often they open. Without
    // this a rung-15 president ran its signature at exactly the pace a rung-1
    // one did, which is most of why the top of the ladder used to feel flat:
    // the numbers got sharper but the fight did not get faster.
    //
    // 1.02 → 0.76 dwell: a top-rung coil is about a quarter shorter, which is
    // still long enough to see and block. Going below ~0.7 starts eating the
    // tell itself, and an unreadable phrase is just damage, not difficulty.
    this.patTempo = 1.02 - 0.26 * ((level - 1) / (MAX_RUNG - 1));
    // 1.00 → 0.68 cadence: the top of the ladder opens a phrase roughly every
    // 3.5 s where the bottom takes 5.4 s, so pressure scales with the rung too.
    //
    // 2026-09-13: both figures used to start at 1.10 / 1.20, which meant a
    // rung-1 president ran its signature at 110% of its written dwell only once
    // every ~6.5 s — long enough that a player could finish the fight having
    // seen the phrase twice and read it as noise. The bottom of the ladder now
    // plays its repertoire at roughly its written tempo and cadence: the same
    // phrase, often enough to actually be learnable, which is both the low-rung
    // difficulty lift and the point of having written the phrases at all. The
    // top of the ladder is unchanged.
    this.patCadence = 1.00 - 0.32 * ((level - 1) / (MAX_RUNG - 1));

    // ── Reactive-block reaction floor ─────────────────────────────────
    // How long an opponent's wind-up must have been VISIBLE before the reactive
    // block below is allowed to answer it. Without one the guard went up on the
    // first frame of the wind-up, because the AI reads the state machine rather
    // than the animation — at rung 15 that meant a 97% chance of blocking a jab
    // whose entire wind-up is four frames, which is not a hard opponent so much
    // as an unbeatable one. Worse under the perfect-guard rules the engine now
    // applies to both sides (game.js PERFECT_GUARD_WINDOW): a frame-0 guard is
    // always "perfect", so every jab you threw handed back a free counter.
    //
    // 0.24 s at rung 1 down to 0.09 s at rung 15, against the frame data in
    // game.js ATTACKS (punch wind-up 0.06 s, kick 0.12 s, a held coil as long as
    // it is held). The resulting rule is simple enough for a player to feel:
    //   • nobody can react to a bare jab — trading jabs is always live;
    //   • only the last three rungs (13-15) get under a kick's 0.12 s wind-up.
    //     This line read "the last two" and was off by one against its own
    //     formula both before and after the 2026-09-13 retune — rung 13 landed
    //     at 0.117 s on the old numbers too. The boundary is the claim worth
    //     keeping, so it is the comment that moved, not the curve;
    //   • a held coil is long enough for anyone to answer, so whether it gets
    //     guarded is down to blockP alone — which is the point of rolling that
    //     once per swing rather than per tick (see the reactive-defense block).
    // The 0.24 s floor is deliberately still well above a kick's 0.12 s wind-up
    // and four times a punch's: the low-rung lift buys the early ladder more
    // reads, not superhuman ones, and "nothing below rung 13 can react to a
    // poke" is an invariant a player can build a gameplan on.
    this.reactFloor = 0.24 - 0.15 * ((level - 1) / (MAX_RUNG - 1));
    // Engine time the opponent's current wind-up began, or -1 between swings,
    // and whether this rung has already taken its single block roll on it.
    this._oppWindupSince = -1;
    this._windupRolled = false;

    // Personality (charId) layer. Optional additive AI knobs (e.g. HW Bush's
    // "Read My Lips" / "Voodoo Feints" — +12% blockP, +10% punishP, +30% baitP).
    // The engine instantiates this controller with `charId` when known.
    this.charId = charId;
    this._personalityMods = { blockP: 0, baitP: 0, punishP: 0 };
    if (this.charId && PERSONALITIES[this.charId]?.passiveAiBoost) {
      const b = PERSONALITIES[this.charId].passiveAiBoost;
      this._personalityMods = { ...b };
      this.blockP = Math.min(0.98, this.blockP + (b.blockP || 0));
      this.baitP = Math.min(0.6, this.baitP + (b.baitP || 0));
      this.punishP = Math.min(0.98, this.punishP + (b.punishP || 0));
    }

    this.rng = rng || { random: Math.random };
    this.sinceDecision = 1e9;
    this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
    this.retreatUntil = 0;
    this.recentHits = [];
    this.t = 0;
    // Used to occasionally start a swing then cancel to block on the next decision.
    this.baitArmed = false;
    this.baitStartedAt = 0;
    // Hold-to-charge plan: while holdName is set the AI keeps the button
    // held (the engine charges the attack), releasing at holdUntil. Higher
    // rungs charge more often and wind up longer.
    this.holdName = null;
    this.holdUntil = 0;
    this.chargeP = p.chargeP;

    // ── Footwork signature (see personalities.js `footwork`) ──────────
    // The president's neutral-game dance: a fixed cycle of move/orbit beats
    // replayed on the engine clock for the whole fight. Deliberately NOT scaled
    // by rung — the rung decides how sharp a president is, the dance decides who
    // he is, and a tempo that moved with the ladder would invalidate the read a
    // player learned three rungs earlier.
    //
    // Cached cycle length so `_footBeat` is a modulo rather than a scan-sum.
    this.footwork = (this.charId && PERSONALITIES[this.charId]?.footwork) || null;
    this._footCycle = this.footwork
      ? this.footwork.reduce((s, b) => s + (b.secs || 0.3), 0) : 0;
    // True while the last decision left the fighter in neutral (approaching,
    // holding, giving ground) rather than committed to a swing, a guard or a
    // charge. Only then are the feet refreshed every tick — see `update`.
    this._footLive = true;
    // Engine time we last managed to close ground. The dance may hold or give
    // ground on its own beat, but it must never be able to stall a round out;
    // see FOOT_STALL_MAX.
    this._closedAt = 0;
    // Signature pattern state (see _runPattern). `_pat` is the phrase currently
    // playing out, `_patReadyAt` the wall-clock time the next one may open.
    //
    // These replace the old bidenChargeReadyAt / obamaComboReadyAt pair. Those
    // were two hand-written `if (this.charId === 'x')` blocks — the only two
    // presidents whose fighting STYLE differed at all, which is why the other
    // thirteen were mechanically interchangeable at a given rung. Both are now
    // ordinary rows in the same data table as everyone else.
    this._pat = null;
    // Repertoire cursor. Every president owns an ordered array of phrases
    // (personalities.js `aiPatterns`) and the rung decides how many of them are
    // in play — see _unlockedPatterns. `_patIdx` walks that window in a fixed
    // cycle, never a random pick, so the ORDER is learnable the same way the
    // steps inside one phrase are.
    this._patIdx = 0;
    // Stagger the first opening so a fighter does not lead with its signature
    // before the player has seen it fight normally — and so demo pairings do
    // not open in lockstep. Seeded RNG, so replays stay deterministic.
    this._patReadyAt = 1.2 + this.rng.random() * 1.5;
    // Pre-planned punch→kick cancel string (rungs 5+): fire the kick edge when
    // t reaches comboAt, drop the plan if the window is missed.
    this.comboAt = 0;
    this.comboUntil = 0;
    // Rolling habit counters (exponentially decayed, HABIT_TAU memory).
    this.obsT = 0;       // decayed in-range observation time
    this.oppBlockT = 0;  // decayed in-range time the opponent spent blocking
    this.oppAtkN = 0;    // decayed count of opponent attack starts
    this.clockT = 0;     // decayed total time (normalizer for the attack rate)
    this.prevOppWindup = false;
  }

  notifyHit() {
    this.recentHits.push(this.t);
    this.recentHits = this.recentHits.filter((h) => this.t - h < 1.5);
    if (this.recentHits.length >= 2) this.retreatUntil = this.t + 0.7;
    // Taking a hit dumps any charge the engine was holding for us.
    this.holdName = null;
    // ...and breaks the signature phrase. This is the counterplay: every
    // pattern has a moment where it is committed and open, and a player who has
    // learned to read it gets to cut it off there. Without this the phrase
    // would play through the interruption and reading it would earn nothing.
    this._pat = null;
  }

  /**
   * ctx shape (extended by the engine):
   *   { dt, distance, kickRange,
   *     opponentState, opponentStateT,           // 'punch'|'kick'|'hitstun'|...
   *     opponentWindup, opponentActive, opponentRecover, // booleans this tick
   *     selfExhausted, opponentExhausted,        // energy gate, both sides
   *     ownAttacks: { punch: {...}, kick: {...} } // with windup/active/recover
   *   }
   */
  // ── Habit tracking ────────────────────────────────────────────────────
  // Decayed counters: multiply by exp(-dt/tau) each tick, then add this tick's
  // observation, so the read always reflects roughly the last HABIT_TAU seconds.
  _observe(ctx) {
    const decay = Math.exp(-ctx.dt / HABIT_TAU);
    const inRange = ctx.distance < ctx.kickRange * 1.25;
    this.obsT = this.obsT * decay + (inRange ? ctx.dt : 0);
    this.oppBlockT = this.oppBlockT * decay
      + (inRange && ctx.opponentState === 'block' ? ctx.dt : 0);
    this.clockT = this.clockT * decay + ctx.dt;
    this.oppAtkN *= decay;
    if (ctx.opponentWindup && !this.prevOppWindup) {
      this.oppAtkN += 1;
      // Stamp the frame the wind-up became visible; the reactive block measures
      // its reaction floor from here rather than firing on the same tick.
      this._oppWindupSince = this.t;
      this._windupRolled = false;
    }
    if (!ctx.opponentWindup) this._oppWindupSince = -1;
    this.prevOppWindup = ctx.opponentWindup;
  }

  // 0..1 — how much of recent in-range time the opponent spent blocking.
  _turtleRead() {
    if (this.obsT < 1.5) return 0; // not enough evidence yet
    return Math.max(0, this.oppBlockT / this.obsT - TURTLE_THRESHOLD);
  }

  // Attacks/sec above the spam threshold (0 when calm).
  _spamRead() {
    if (this.clockT < 1.5) return 0;
    return Math.max(0, this.oppAtkN / this.clockT - SPAM_THRESHOLD);
  }

  // ── Footwork signature ────────────────────────────────────────────────
  // The neutral-game counterpart to the pattern runner below. Where a phrase is
  // a committed script that owns the fighter for a couple of seconds, this is
  // the rhythm underneath it — the thing the player is watching for most of the
  // round, and until 2026-09-13 the one part of a president that was identical
  // across the whole roster.
  //
  // Keyed off `this.t` alone, so the cycle never resets: not on a hit, not on a
  // phrase, not on a knockdown. A dance that restarted on contact would be
  // unlearnable for exactly the reason a randomised phrase is.

  /** The beat this president is on right now, or null when it has no dance. */
  _footBeat() {
    if (!this.footwork || this._footCycle <= 0) return null;
    let u = this.t % this._footCycle;
    for (const b of this.footwork) {
      const s = b.secs || 0.3;
      if (u < s) return b;
      u -= s;
    }
    return this.footwork[this.footwork.length - 1];
  }

  /**
   * The beat as a movement intent.
   * @param close true when we are out of range. A retreat beat is clamped to a
   *   hold, and if the dance has kept us out of range past FOOT_STALL_MAX we
   *   close regardless of what the beat says. The orbit component is never
   *   clamped, so the signature still reads at every distance.
   */
  _footIntent(close) {
    const beat = this._footBeat();
    // No signature — BOB, or a controller built without a charId (the demo and
    // 2p fallbacks). Keep the pre-2026-09-13 behaviour rather than inventing
    // one: walk in with an occasional random arc, give ground in neutral.
    if (!beat) {
      const side = this.rng.random() < 0.18 ? (this.rng.random() < 0.5 ? 1 : -1) : 0;
      return { move: close ? 1 : -1, side: close ? side : 0 };
    }
    let move = beat.move ?? 0;
    if (close) {
      move = Math.max(0, move);
      if (move > 0) this._closedAt = this.t;
      else if (this.t - this._closedAt > FOOT_STALL_MAX) move = 1;
    } else {
      this._closedAt = this.t;
    }
    return { move, side: beat.side || 0 };
  }

  // ── Signature pattern runner ──────────────────────────────────────────
  // Every president owns an ordered repertoire of scripted phrases
  // (personalities.js `aiPatterns`) that it cycles on a fixed cadence for the
  // whole fight. This is the layer that makes the roster feel like fifteen
  // fighters instead of one fighter in fifteen skins: the rung table above
  // decides how SHARP a president is, and the repertoire decides how it FIGHTS.
  //
  // The design constraint is learnability, so neither the script nor the order
  // it is played in is randomised. Same trigger, same order, same rhythm, every
  // time — that is what lets a player who has lost to Nixon four times notice
  // he always backs off a beat before he lunges, and start punishing the
  // retreat. A pattern that varied would just read as noise.
  //
  // Three properties keep it fair rather than oppressive:
  //   • it only starts in range and off cooldown, so it cannot chase you down;
  //   • landing a hit CANCELS it (see notifyHit) — every phrase has a window
  //     where interrupting beats it, which is the reward for reading it;
  //   • it is a phrase, not a loop, so there is always recovery time after.

  /**
   * How much of this president's repertoire this rung is allowed to use.
   * Low rungs run one phrase, the middle alternates two, the top cycles all
   * three. This is a difficulty axis the numeric table cannot express: a rung-2
   * president is beaten by learning ONE tell, while a rung-13 one makes you
   * learn a three-phrase song before the reads pay off. It is also why the
   * entries in `aiPatterns` are ordered — index 1 is written as the answer to
   * having learned index 0.
   */
  _unlockedPatterns() {
    const all = PERSONALITIES[this.charId]?.aiPatterns;
    if (!all || !all.length) return null;
    // 1..3 → 1 phrase, 4..9 → 2, 10..15 → 3 (clamped to what exists).
    //
    // 2026-09-13: the boundaries were 5 and 10, so the first FIVE rungs were a
    // one-phrase fight. Repertoire depth is the difficulty axis the numeric
    // table cannot express — a second phrase is a second thing to learn before
    // the reads pay off — and spending five of the fifteen rungs at depth 1 is
    // most of why the bottom of the ladder felt like the same easy opponent
    // five times. Rungs 1-3 still open at depth 1 so the ladder's first fights
    // remain the ones that teach the mechanic.
    const depth = Math.min(all.length, this.level >= 10 ? 3 : this.level >= 4 ? 2 : 1);
    return all.slice(0, depth);
  }

  _patternDue(ctx) {
    const set = this._unlockedPatterns();
    if (!set || this.holdName || this.t < this.retreatUntil) return false;
    if (this.t < this._patReadyAt) return false;
    // Range gate: measured against the NEXT phrase's own reach so a crowding
    // phrase (LBJ) can open from further out than a counter-punch (Bush Sr.).
    const pat = set[this._patIdx % set.length];
    return ctx.distance < ctx.kickRange * (pat.range || 1.2);
  }

  _startPattern(ctx) {
    const set = this._unlockedPatterns();
    const pat = set[this._patIdx % set.length];
    // Advance the cursor on OPEN, not on finish: a phrase that gets interrupted
    // still counts as played, so cutting one off moves the fight on to the next
    // one instead of replaying the phrase the player just proved they can read.
    this._patIdx = (this._patIdx + 1) % set.length;
    // Rung tempo scales the dwell of every step, so the same written phrase is
    // a slow, obvious lesson low on the ladder and a tight one at the top.
    this._pat = {
      steps: pat.steps, i: 0, until: 0, fired: false, tempo: this.patTempo,
    };
    // Cadence is measured from the START of the phrase, so the gap a player
    // learns to count is the gap between openings, not between endings.
    this._patReadyAt = this.t + (pat.everySecs || 5) * this.patCadence;
    // A phrase supersedes any half-formed plan from the random layer, and owns
    // the feet outright: its own advance/retreat/sidestep steps are the dance
    // for as long as it runs.
    this._footLive = false;
    this.baitArmed = false;
    this.comboAt = 0;
    this.comboUntil = 0;
  }

  // Returns an intent while the phrase is mid-flight, or null once it ends
  // (letting the normal decision loop resume on the same tick).
  _runPattern(ctx) {
    const p = this._pat;
    const step = p.steps[p.i];
    if (!step) { this._pat = null; return null; }

    // Entering a step: stamp its dwell and let this tick carry the press edge.
    // `tempo` is the rung's execution speed (see _startPattern) — the same
    // written phrase, delivered faster the higher up the ladder you are.
    if (p.until === 0) {
      p.until = this.t + (step.secs || 0.2) * p.tempo;
      p.fired = false;
    }

    const done = this.t >= p.until;
    const out = this._stepIntent(step, p.fired);
    p.fired = true;

    if (done) {
      p.i += 1;
      p.until = 0;
      // Dropping the held flag on the frame a `charge` step ends is what makes
      // the engine release the strike — the release is the step boundary.
      if (p.i >= p.steps.length) {
        this._pat = null;
        this.sinceDecision = 0;
      }
    }
    return out;
  }

  // One step → one intent. `edgeSpent` suppresses the press edge on every frame
  // after the first: punch/kick are edge-triggered, and re-pressing each frame
  // would restart the swing the moment the engine returned to idle.
  _stepIntent(step, edgeSpent) {
    const base = { move: 0, side: 0, punch: false, kick: false, block: false, super: false };
    const atk = step.attack || 'punch';
    switch (step.act) {
      case 'punch':
      case 'kick':
        return edgeSpent ? base : { ...base, [step.act]: true };
      case 'charge': {
        // Press once, then hold. The engine charges for as long as *Held is
        // set and throws the strike when it drops — see _tickFighter's charge
        // case — so the visible coil IS this step's duration.
        const out = { ...base, [atk + 'Held']: true };
        if (!edgeSpent) out[atk] = true;
        return out;
      }
      case 'block':    return { ...base, block: true };
      case 'advance':  return { ...base, move: 1 };
      case 'retreat':  return { ...base, move: -1 };
      // Held for the step's whole duration, not edge-triggered: `side` became a
      // sustained orbit when the circle keys landed, so a one-frame pulse would
      // have quietly turned every sidestep phrase (Obama, Clinton, JFK) into a
      // pause the player could not see.
      case 'sidestep': return { ...base, side: step.dir || -1 };
      case 'wait':
      default:         return base;
    }
  }

  /**
   * Commit to a held coil and return the intent that starts it.
   *
   * The engine charges for as long as `<name>Held` is set and throws the strike
   * on the frame it drops, so the hold window IS the visible wind-up the player
   * reads. One helper for all three coil triggers (gas punish, hitstun, open
   * guard) because they differ only in how long they load and how much they
   * favour the kick — inlining it three times is how the first two drifted
   * apart on which plans they remembered to clear.
   *
   * @param kickBias 0..1 chance the coil is a kick rather than a punch.
   * @param spread   seconds of extra hold on top of the 0.45 s base.
   */
  _loadCharge(kickBias, spread) {
    const name = this.rng.random() < kickBias ? 'kick' : 'punch';
    this.holdName = name;
    this.holdUntil = this.t + 0.45 + this.rng.random() * spread;
    this._footLive = false;   // a loaded coil roots the feet
    this.baitArmed = false;
    this.comboAt = 0;
    this.comboUntil = 0;
    this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
    const out = { ...this.current };
    out[name] = true;            // press edge starts the charge
    out[name + 'Held'] = true;   // and the hold keeps it winding
    return out;
  }

  update(ctx) {
    this.t += ctx.dt;
    this.sinceDecision += ctx.dt * 1000;
    this._observe(ctx);

    // Habit-adjusted probabilities for this tick. Spammers get blocked and
    // whiff-punished more; the bumps are capped so low rungs stay beatable.
    const spam = this._spamRead();
    const turtle = this._turtleRead();
    const effBlockP = Math.min(0.95, this.blockP + spam * 0.5 * this.adapt);
    const effPunishP = Math.min(0.95, this.punishP + spam * 0.4 * this.adapt);
    const effBaitP = Math.min(0.5, this.baitP + turtle * 0.4 * this.adapt);

    // Edge-triggered flags are consumed each read; holds (move/block) persist.
    const intent = { ...this.current, punch: false, kick: false, side: 0 };

    // ── Gassed out ──────────────────────────────────────────────────────
    // Energy is under the floor, so the engine will refuse every punch and kick
    // until the bar recovers (game.js _canAttack). Guard and hold — blocking is
    // by far the fastest refill, so this is both the correct play and the way
    // out. Placed ahead of the pattern runner and the charge hold deliberately:
    // both of those would otherwise keep feeding attack inputs into a closed
    // gate for the whole recovery, which looks like the CPU freezing up.
    //
    // Backing off while gassed keeps the CPU from simply standing in range
    // eating a free combo, but it stays in the fight rather than fleeing.
    if (ctx.selfExhausted) {
      this._pat = null;
      this.holdName = null;
      this.sinceDecision = 0;
      this._footLive = false;   // the dance is off while catching a breath
      const backoff = ctx.distance < ctx.kickRange * 0.9 ? -1 : 0;
      this.current = { move: backoff, side: 0, punch: false, kick: false, block: true };
      return { ...this.current, super: false };
    }

    // ── Signature pattern ───────────────────────────────────────────
    // A running script owns the fighter outright until it finishes or is
    // interrupted, so it plays out as one readable phrase rather than being
    // diluted by the random weights below.
    if (this._pat) {
      const out = this._runPattern(ctx);
      if (out) return out;
    } else if (this._patternDue(ctx)) {
      this._startPattern(ctx);
      const out = this._runPattern(ctx);
      if (out) return out;
    }

    // ── Active charge hold ──────────────────────────────────────────────
    // A charge plan overrides everything: keep the button held until the
    // release time, then drop the held flag so the engine throws the strike.
    if (this.holdName) {
      if (this.t < this.holdUntil) {
        const out = { move: 0, side: 0, punch: false, kick: false, block: false, super: false };
        out[this.holdName + 'Held'] = true;
        return out;
      }
      this.holdName = null;
      this.sinceDecision = 0;
      return { move: 0, side: 0, punch: false, kick: false, block: false, super: false };
    }

    // ── Signature super activation ────────────────────────────────────
    // When the comeback meter is full, the AI spends it on its signature
    // move. Rung drives the chance per tick (low rungs hoard the meter, high
    // rungs know exactly when to spend). The engine handles the actual
    // application — the AI just signals `intent.super = true` once.
    //
    // Cooldown: a hard-coded 4-second window after firing before the AI is
    // allowed to fire again. Prevents accidental back-to-back activations
    // from a refill before the meter has had time to build. The intent.super
    // edge is consumed by the engine after the first read (intent is dropped
    // by the engine after _fireSuper returns), so this is naturally one-shot
    // per meter fill.
    if (ctx.superMeterFull && this.t >= (this.superCooldownUntil || 0)) {
      // Ramp-up: low rungs fire rarely, high rungs fire on the first full
      // tick they can. The gate is a per-tick probability scaled by rung.
      const superP = Math.min(0.85, 0.15 + (this.level - 1) * 0.05);
      // Don't fire into the windup of an opponent swing we're blocking —
      // it's a wasted activation if they're not in range / not in stun.
      const oppVulnerable = ctx.opponentState === 'hitstun'
        || ctx.opponentState === 'block'
        || (ctx.opponentWindup && ctx.distance < ctx.kickRange * 1.1)
        || ctx.opponentState === 'idle';
      if (oppVulnerable && this.rng.random() < superP) {
        this.superCooldownUntil = this.t + 4.0;
        return { move: 0, side: 0, punch: false, kick: false, block: false, super: true };
      }
    }

    // ── Pre-planned cancel string (rungs 5+) ────────────────────────────
    // A punch committed with a combo plan cancels into kick exactly when the
    // frame-data window opens. Fires outside the reaction gate — the string
    // was decided when the punch started, not as a reaction.
    if (this.comboAt > 0 && this.t >= this.comboAt) {
      const missed = this.t > this.comboUntil
        || ctx.distance > ctx.kickRange * 1.1;
      this.comboAt = 0;
      this.comboUntil = 0;
      if (!missed) {
        this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
        this.sinceDecision = 0;
        return { ...this.current, kick: true };
      }
    }

    // ── Reactive defense ────────────────────────────────────────────────
    // Block during the opponent's windup, but only once it has been visible for
    // this rung's reaction floor — see the constructor. A swing whose whole
    // wind-up is shorter than the floor simply cannot be answered this way,
    // which is what keeps fast pokes live against the top of the ladder.
    //
    // ONE roll per swing, not one per tick. This used to re-roll every frame the
    // windup was up, which quietly made blockP a function of how long the swing
    // took rather than of the rung: over the ~25 frames of a held coil even
    // blockP 0.10 compounded to a ~93% guard, so a rung-1 president defended a
    // haymaker about as well as a rung-15 one and the column did almost nothing
    // where it mattered most. Rolled once, blockP means what its name says —
    // the chance THIS swing gets guarded — and the ladder separates properly.
    const windupSeen = this._oppWindupSince >= 0
      && (this.t - this._oppWindupSince) >= this.reactFloor;
    if (windupSeen && !this._windupRolled && ctx.distance < ctx.kickRange * 1.25) {
      this._windupRolled = true;
      if (!this.current.block && this.rng.random() < effBlockP) {
        this.current = { move: 0, side: 0, punch: false, kick: false, block: true };
        this.sinceDecision = 0;
        this._footLive = false;
        this.baitArmed = false;
        this.comboAt = 0;
        this.comboUntil = 0;
        return { ...this.current };
      }
    }

    // ── Footwork between decisions ──────────────────────────────────────
    // The feet run on the engine clock, not the decision clock. reactionMs
    // gates DECISIONS — whether to swing, guard, back off — but the dance is a
    // fixed rhythm the player is meant to count, and sampling it only once per
    // reactionMs would drop a 0.25 s beat entirely at the bottom of the ladder
    // and turn every signature into the same slow trudge. So while the fighter
    // is in neutral, the feet are refreshed every tick.
    //
    // `_footLive` is what keeps that from overriding a commitment: it is
    // cleared by every branch below that decides to swing, guard, bait or
    // charge, and set again by the branches that decide to move. Without it a
    // president who chose to plant and block would walk out of his own guard on
    // the next tick.
    if (this._footLive && this.footwork) {
      const foot = this._footIntent(ctx.distance > ctx.kickRange);
      this.current.move = foot.move;
      this.current.side = foot.side;
      intent.move = foot.move;
      intent.side = foot.side;
    }

    if (this.sinceDecision < this.reactionMs) return intent;
    this.sinceDecision = 0;

    // ── Anti-stunlock retreat ───────────────────────────────────────────
    // Survival, not signature: the dance is suspended while backing out of a
    // string. Coming out of it the feet pick the cycle back up wherever the
    // engine clock has got to, which is the point of never resetting it.
    if (this.t < this.retreatUntil) {
      this.current = { move: -1, side: 0, punch: false, kick: false, block: false };
      this._footLive = false;
      return { ...this.current };
    }

    // ── Gas punish: the opponent spent their bar, so make them pay ─────
    // A gassed fighter cannot punch or kick at all until the bar recovers
    // (game.js _canAttack), and the fastest route back up is the guard. So an
    // opponent standing there gassed is either about to block — in which case a
    // coil is the right call anyway, since a blocked charge is the one thing
    // that refills them — or about to eat the biggest swing in the game.
    //
    // This is the sharpest end of "learn to block": a player who empties the
    // bar mashing attack gets a fully loaded coil aimed at them for their
    // trouble, and the only way out of it is the button they were not pressing.
    // Ahead of the hitstun coil below because it is the better read of the two
    // when both are true — hitstun lasts 0.35 s, the gas window lasts seconds.
    if (ctx.opponentExhausted && ctx.distance < ctx.kickRange * 1.15
        && this.rng.random() < this.punishGasP) {
      return this._loadCharge(0.55, 0.55);
    }

    // ── Charged attack: wind up while the opponent can't answer ────────
    // The opponent is stuck in hitstun and in range — occasionally commit to
    // a held charge instead of a tap. The visible coil is the player's cue
    // to block or interrupt when the stun wears off.
    if (ctx.opponentState === 'hitstun' && ctx.distance < ctx.kickRange
        && this.rng.random() < this.chargeP) {
      return this._loadCharge(0.45, 0.5);
    }

    // ── Open-guard coil: punish a player who never blocks ──────────────
    // The opponent is in range, doing nothing in particular, and NOT guarding.
    // Higher rungs read that as an invitation and commit to a coil rather than
    // a jab. The turtle read damps it — against a player who does guard there
    // is no lesson left to teach here, and kicks are already the better answer
    // (see the kick shift below), so the AI stops spending the wind-up.
    if (ctx.opponentState === 'idle' && ctx.distance < ctx.kickRange
        && this.rng.random() < this.chargeP * 0.5 * (1 - Math.min(1, turtle * 2))) {
      return this._loadCharge(0.4, 0.45);
    }

    // ── Out of range: close on this president's own footwork ────────────
    // This used to be `move: 1` plus an 18% random sidestep, which is to say
    // every president in the roster approached identically and the only thing
    // separating them at range was noise. The approach is now the signature
    // cycle (personalities.js `footwork`), clamped so it can only close or hold
    // — Trump stalks straight in, Obama arcs, Carter comes on the metronome,
    // JFK darts side to side — and it keeps updating between decisions via the
    // per-tick refresh above, so the rhythm survives a 560 ms reaction gate.
    //
    // The circle is stored ON this.current rather than tacked onto the returned
    // copy. `side` used to be an edge-triggered dart, so one frame of it was a
    // whole sidestep; it is a held orbit direction now, and a single frame of
    // that is an imperceptible nudge.
    if (ctx.distance > ctx.kickRange) {
      const foot = this._footIntent(true);
      this.current = {
        move: foot.move, side: foot.side, punch: false, kick: false, block: false,
      };
      this._footLive = true;
      this.baitArmed = false;
      return { ...this.current };
    }

    // ── In range: frame-data aware choices ──────────────────────────────
    // 1) If opponent is in active/recover, whiff-punish with our fastest move.
    // 2) If a bait is armed and we're past its window, cancel into block.
    // 3) Otherwise weight: punch (35%), kick (25%), block (15%), retreat (10%), wait (15%).
    if (this.baitArmed && (this.t - this.baitStartedAt) > (ctx.ownAttacks.punch.windup + 0.02)) {
      // Cancel the bait into block — looks like the AI feinted.
      this.current = { move: 0, side: 0, punch: false, kick: false, block: true };
      this.baitArmed = false;
      this._footLive = false;
      return { ...this.current };
    }

    if ((ctx.opponentActive || ctx.opponentRecover) && this.rng.random() < effPunishP) {
      // Punch is the fastest move — best for punishing recovery.
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
      this.baitArmed = false;
      this._footLive = false;
      return { ...this.current, punch: true };
    }

    // Attack shares scale with the rung's aggression; the leftover probability
    // shifts into block/retreat/wait, so low rungs mostly shuffle around.
    // Vs a turtle, punch share shifts into kick: the guard only covers the
    // forearms, so kicks to the legs connect through a standing block.
    const r = this.rng.random();
    let pPunch = 0.35 * this.aggro;
    let pKick = 0.25 * this.aggro;
    const kickShift = Math.min(pPunch * 0.6, turtle * 0.8 * this.adapt);
    pPunch -= kickShift;
    pKick += kickShift;
    if (r < pPunch) {
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
      this.baitArmed = false;
      this._footLive = false;
      // Rungs 2+ sometimes commit to the punch as the opener of a
      // punch→kick cancel string (see the combo block above).
      if (this.comboP > 0 && this.rng.random() < this.comboP) {
        this.comboAt = this.t + ctx.ownAttacks.punch.cancelInto.kick + 0.04;
        this.comboUntil = this.comboAt + 0.15;
      }
      return { ...this.current, punch: true };
    } else if (r < pPunch + pKick) {
      this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
      this.baitArmed = false;
      this._footLive = false;
      return { ...this.current, kick: true };
    } else if (r < pPunch + pKick + 0.15) {
      // Optionally arm a bait: start a punch, then cancel into block next tick.
      this._footLive = false;
      if (this.rng.random() < effBaitP) {
        this.baitArmed = true;
        this.baitStartedAt = this.t;
        this.current = { move: 0, side: 0, punch: false, kick: false, block: false };
        return { ...this.current, punch: true };
      }
      this.current = { move: 0, side: 0, punch: false, kick: false, block: true };
    } else {
      // ── Neutral share: walk the signature ─────────────────────────────
      // The remaining probability used to split into a fixed 15% backpedal and
      // an idle remainder, both of which looked the same from every president.
      // It is one branch now and it hands the tick to the footwork cycle, so
      // whatever the low rungs do not spend on attacking is spent visibly being
      // Ford or Eisenhower rather than standing still being punchable.
      //
      // A fighter with no signature keeps the original split exactly: the first
      // 0.15 of this share backpedals, the rest stands still.
      const foot = this.footwork
        ? this._footIntent(false)
        : { move: r < pPunch + pKick + 0.30 ? -1 : 0, side: 0 };
      this.current = {
        move: foot.move, side: foot.side, punch: false, kick: false, block: false,
      };
      this._footLive = true;
    }
    this.baitArmed = false;
    return { ...this.current };
  }

  dispose() {}
}