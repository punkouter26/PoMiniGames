// personalities.js — Punch-Out!!-style fighting patterns, one per president.
//
// Each entry is a pure-data description of how a president breaks the default
// rung-based AI behavior. The engine reads these to:
//   • pick profile-driven AI knobs (Trump spams combos, HW Bush block-punishes)
//   • per-tick damage/speed modifiers tied to fighter state (Reagan comeback)
//   • on-swing special effects (Biden charge, Nixon dirty attacks, Ford stumble)
//   • on-KO buffs (Trump KO-stack damage ramp)
//   • on-hit status effects on the defender (blind, slow, retaliate window)
//
// Trigger rules:
//   triggerOnce      — engine checks once per ROUND, fires if HP threshold met
//   checkHpBelow(p)   — true while fighter HP% <= p
//   checkHpAbove(p)   — true while fighter HP% >= p
//   onSwingP          — (0..1) chance to throw a "haymaker"/"dirty"/"stumble"
//   onKoReceived      — increments a counter (per charId, e.g. koStacks for trump)
//   activeFor(t)      — effect auto-clears after t seconds
//
// All HP thresholds are PERCENT (0..1). The engine passes the live value at
// trigger evaluation time so an effect can be HP-conditional.

export const PERSONALITIES = {
  // ── Trump — "THE WALL" → after every KO, +5% damage per stack (5 max) ──
  // Volume-spammer: ~18% of swings commit to a heavy haymaker (1.5× dmg, 1.3× kb).
  trump: {
    onSwingP: { haymakerDmgMul: 1.5, haymakerKBMul: 1.3, haymakerChance: 0.18 },
    onKoReceived: 'stack',
    stackKey: 'koStacks',
    perStackDmg: 0.05,
    maxStacks: 5,
    onStackHit: 'voiceWall',
  },

  // ── Biden — "The Big Guy" charge ─────────────────────────────────────
  // Every ~5 s of fighting he winds up a 1.0 s charge. If it lands the
  // defender's moveMul is halved for 1.0 s ("corner-rattle" → opener).
  biden: {
    chargeEverySecs: 5.5,
    chargeWindupMul: 2.0,
    chargeHoldSecs: 1.0,
    onChargeHitEffect: 'slow',
    onHitEffectParams: { slowMul: 0.5, slowSecs: 1.0 },
  },

  // ── Obama — "No-Drama Open" / "Drone Strike" combo ─────────────────
  // Counter-puncher: every ~4 s commits to a pre-planned jab→kick string.
  // Passive: 25% chance any incoming attack "misses" (heavy lean dodge).
  obama: {
    comboEverySecs: 4,
    comboIsPunchKick: true,
    passiveDodgeChance: 0.22,
  },

  // ── Bush (W.) — "Decider Mode" ─────────────────────────────────────
  // Mid-fight when HP drops below 40%, freezes for 1.5 s ("decision time")
  // then gains +40% damage and +15% speed for the remainder of the round.
  bush: {
    triggerOnce: true,
    checkHpBelow: 0.40,
    onTrigger: 'decider',
    onTriggerParams: { freezeSecs: 1.5, atkMul: 1.4, speedMul: 1.15 },
  },

  // ── Clinton — "Sax Solo" + "I Feel Your Pain" elbow flurry ─────────
  // Windup is 1.5× longer (the sax sway). Every successful hit chains into
  // a 4-jab elbow flurry whose count grows with the player's recent misses.
  clinton: {
    onSwingP: { saxSoloWindupMul: 1.5 },
    onHitChain: { name: 'feelYourPain', hits: 4, growthPerOppMiss: 1, growthCap: 6 },
  },

  // ── Bush Sr. — "Read My Lips" + "Voodoo Economics" feints ──────────
  // Additive boosts to the AI table — he's the counter-fighter par excellence.
  // 30% of his windups become feints; blockers open up to guaranteed heavies.
  bushsr: {
    passiveAiBoost: { blockP: +0.12, punishP: +0.10, baitP: +0.30 },
    onFeintTrigger: 'counter',
    onCounterHitKBMul: 1.45,
  },

  // ── Reagan — "Morning in America" + "Tear Down This Wall" ──────────
  // At <25% HP, gains +40% dmg and +20% speed for 6 s. Once per round he
  // can plant a 1.5 s guard that reflects 30% of damage back to attacker.
  reagan: {
    triggerOnce: true,
    checkHpBelow: 0.25,
    onTrigger: 'morningInAmerica',
    onTriggerParams: { atkMul: 1.4, speedMul: 1.2, durationSecs: 6 },
    oncePerRound: {
      name: 'tearDownThisWall',
      guardSecs: 1.5,
      reflectFraction: 0.30,
      selfStaggerSecs: 0.6,
    },
  },

  // ── Carter — "Malaise Speech" + "Habitat for Humanity" ──────────────
  // Malaise Speech: once per round, when he first drops below 30% HP, gains
  // 1.5 s iframes while waving his finger (engine-side skip on hitstun).
  // Habitat for Humanity: each successful personal hit bumps a combo ladder
  // by 1 (1 → 2 → 3 → 4 hits). Resets if he goes 3 s without landing.
  carter: {
    triggerOnce: true,
    checkHpBelow: 0.30,
    onTrigger: 'malaiseSpeech',
    onTriggerParams: { iframesSecs: 1.5 },
    passive: {
      name: 'habitatForHumanity',
      comboLadderMax: 4,
      comboResetsAfterSecs: 3,
    },
  },

  // ── Ford — "Ford Stumble" + "Pardoning Nixon" ──────────────────────
  // 15% of his swings he trips on his own foot and self-stuns 0.6 s.
  // If the player hits him DURING the stumble, Ford retaliates with a
  // 2× damage window for 1.5 s (turn the stumble into a hidden buff).
  ford: {
    onSwingP: { stumbleChance: 0.15, stumbleSelfStunSecs: 0.6 },
    onStumbleHit: { retaliateDmgMul: 2.0, retaliateSecs: 1.5 },
  },

  // ── Nixon — "Tricky Dick" + "I Am Not a Crook" ────────────────────
  // 25% of his attacks are "dirty" — they ignore 40% of the block absorption.
  // Once per round, eye-gouge: 30% chance to apply 0.3 s of input-blind
  // (player block presses drop) on a successful dirty hit.
  nixon: {
    onSwingP: { dirtyChance: 0.25, dirtyBlockFraction: 0.40 },
    oncePerRound: {
      name: 'eyeGouge',
      procChance: 0.30,
      blindSecs: 0.30,
      blindMissRate: 0.30,
    },
  },

  // ── LBJ — "The Johnson Treatment" + "All the Way with LBJ" ──────────
  // The Johnson Treatment: every time the OPPONENT MISSES a swing in range,
  // LBJ's NEXT swing carries +50% knockback (he "arm-twists" you through
  // the miss). Caps at one missed-swing bonus at a time, expires 3.5 s.
  // All the Way with LBJ: once per round on first hit, LBJ pumps his fist
  // and his next 3 swings all carry +20% damage. (Passive stack driver.)
  lbj: {
    onOpponentMissCharge: { kbMul: 1.5, expiresSecs: 3.5 },
    oncePerRound: {
      name: 'allTheWay',
      procOnFirstHit: true,
      pumpSwingCount: 3,
      pumpAtkMul: 1.20,
    },
  },

  // ── JFK — "PT-109 Survivor" + "Profiles in Courage" + "Camelot Glint"
  // PT-109: when JFK's HP drops below 50%, his move-while-in-hit's speed
  // spikes by 30% for 4 s (the rip-tide dash). Cooldown 6 s.
  // Profiles in Courage: once per round, ~2.5 s into the match, JFK takes
  // 0.45 s of iframes (a confident pose during which hits pass harmlessly)
  // and gains +25% damage on his next swing after the window ends.
  // Camelot Glint: every 4th swing JFK lands deals +1.4× damage (the rare
  // crowning blow).
  jfk: {
    triggerOnce: true,
    triggerT: 2.5,
    onTrigger: 'profilesInCourage',
    onTriggerParams: { iframesSecs: 0.45, nextSwingAtkMul: 1.25 },
    triggerHpGated: {
      checkHpBelow: 0.50,
      modeName: 'pt109Dash',
      durationSecs: 4.0,
      cooldownSecs: 6.0,
      speedMul: 1.30,
      maxFires: Infinity,
    },
    everyNthHit: { n: 4, mul: 1.4, name: 'camelotGlint' },
  },

  // ── Eisenhower — "Operation Overlord" + "Atoms for Peace" ─────────
  // Operation Overlord: Eisenhower prepares longer (1.5× windup) but his
  // active frames are half as long (dmg window compressed). Result: heavy
  // but punishing — if you block the active window you get a HUGE punish.
  // Atoms for Peace: once per round, after a HP-LEAD swing (>10% HP more
  // than opponent), Eisenhower activates an atomic shield — 1.0 s iframes
  // — mirroring his real-life chess between nuclear war and peaceful use.
  eisenhower: {
    onSwingP: {
      overWindupMul: 1.5,
      overActiveMul: 0.5,
    },
    passiveAiBoost: { blockP: +0.15 },
    triggerOnce: true,
    triggerHpGated: {
      checkHpAboveOpp: 0.10,
      modeName: 'atomsForPeace',
      durationSecs: 1.0,
      iframesSecs: 1.0,
      nextSwingAtkMul: 1.20,
      maxFires: 1,
    },
  },

  // ── Truman — "The Buck Stops Here" + "Give 'em Hell" ──────────────
  // Buck Stops Here: every successful hit TAKEN increases Truman's NEXT
  // swing's damage by +2%, stacking up to +60% (30 hits). Decays 50% of
  // a stack per second of not getting hit (so it ramps in long brawls).
  // Give 'em Hell: 50% of Truman's killing blows trigger an extra camera
  // pulse on KO (cosmetic, a little extra screen shake on the blow that
  // ends the round — the crowd goes wildest when Harry takes the W).
  truman: {
    stacksOnHit: {
      stacksKey: 'buckStacks',
      dmgPerStack: 0.02,
      cap: 30,
      decayPerSec: 0.5,
    },
    onKOSwing: {
      procChance: 0.50,
      extraCamPulse: 0.55,
    },
  },

  // ── FDR — "Four-Term Foundation" + "Fireside Chat" + "Day of Infamy" ──
  // Four-Term Foundation: FDR enters every round warmed up — for the first
  // 3 s of the match his move speed and dmg are +10%.
  // Fireside Chat: every ~6 s FDR slips into a 0.4 s iframe "chat" and on
  // the swing immediately after, his reach is +25%.
  // Day of Infamy: when FDR drops below 30% HP after a strong hit, he rises
  // up with +35% damage for 5 s (the comeback — he led the nation through
  // the worst day in U.S. history).
  fdr: {
    startupBoost: { durationSecs: 3.0, speedMul: 1.10, atkMul: 1.10 },
    triggerOnce: true,
    triggerHpGated: {
      checkHpBelow: 0.30,
      modeName: 'dayOfInfamy',
      durationSecs: 5.0,
      atkMul: 1.35,
      maxFires: 1,
    },
    periodicIframes: {
      everySecs: 6.0,
      iframesSecs: 0.4,
      nextSwingReachMul: 1.25,
    },
  },
};

// Filled per-fighter by the engine on spawn. Holds runtime counters that
// the data-driven table above refers to (so we don't pollute fighter.*).
export function makePersonalityState(id) {
  const p = PERSONALITIES[id];
  return {
    id,
    profile: p || null,
    koStacks: 0,           // trump +0.05 dmg per stack
    lastChargeAt: 0,       // biden charge cooldown timer (s)
    lastComboAt: 0,        // obama pre-planned combo cooldown timer (s)
    triggerFired: false,   // single-fire mid-fight mode (reagan / bush / carter)
    usedThisRound: false,  // oncePerRound flags (reagan / nixon wall + gouge)
    activeMode: null,      // current mode name
    modeExpiresAt: 0,      // wall-clock t when activeMode clears
    iframesUntil: 0,       // carter malaise: skip hitstun until this time
    stumbleUntil: 0,       // ford self-stun end
    retaliateUntil: 0,     // ford damage window end
    habitatComboN: 0,      // carter 1→2→3→4 ladder
    habitatComboT: 0,      // carter last personal-land time
    lastHitWasSax: false,  // clinton sax solo tag
    saxSinceMiss: 0,       // clinton counter count vs opp misses
    // ── New president runtime counters ─────────────────────────────
    lbjMissKBUntil: 0,          // lbj "Treatment" miss-charge window
    lbjPumpSwingsLeft: 0,       // lbj "All the Way" remaining swing buffs
    jfkDashboardCount: 0,       // jfk "Camelot Glint" 4th-hit tracking
    jfkProfileIframesUntil: 0,  // jfk "Profiles in Courage" active i-frames
    jfkNextSwingAtkMul: 1.0,    // jfk post-profile next-swing bonus
    jfkDashUntil: 0,            // jfk PT-109 dash end
    jfkDashCooldownUntil: 0,    // jfk PT-109 cooldown
    eisenhowerMissHitMul: 1.0,  // eisenhower "Overlord" next-hit damage (1.0 = normal)
    eisenhowerActiveFrames: 0,  // eisenhower active-frames compression marker
    eisenhowerIframesUntil: 0,  // eisenhower "Atoms for Peace" shields
    eisenhowerNextSwingAtkMul: 1.0,
    trumanBuckStacks: 0,        // truman "Buck Stops Here" accumulator
    fdrStartupUntil: 0,         // fdr "Four-Term Foundation" active
    fdrIframesUntil: 0,         // fdr "Fireside Chat" chatting
    fdrNextSwingReachMul: 1.0,  // fdr next-swing reach bonus
  };
}
