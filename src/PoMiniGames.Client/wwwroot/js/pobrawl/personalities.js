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
//   onSuper           — signature move. Fires automatically once the comeback
//                       meter (filled by TAKING damage) reaches 1.0 — for a
//                       human the instant it fills, for the AI when its own
//                       rung-paced gate opens. The engine consumes the meter in
//                       `_fireSuper`. There is no super key or super bar.
//   aiPattern         — see below.
//
// All HP thresholds are PERCENT (0..1). The engine passes the live value at
// trigger evaluation time so an effect can be HP-conditional.
//
// ── aiPattern: the president's signature phrase ────────────────────────────
// Everything above changes what a president's hits DO. `aiPattern` changes how
// the president FIGHTS, and it is the only field a player can learn by playing.
//
// Before this existed, thirteen of the fifteen shared one identical decision
// profile — at a given rung they all picked punch/kick/block from the same
// weighted roll, and only Biden and Obama had hand-written cadences. Fighting
// Ford felt exactly like fighting Truman. Now each president replays one
// scripted phrase on a fixed cadence, and that phrase is the thing you come to
// recognise: "he always steps back right before he lunges."
//
// Shape:
//   { everySecs, range, steps: [{ act, secs, attack?, dir? }, …] }
//     everySecs — seconds between OPENINGS (timed from the phrase's start, so
//                 the rhythm a player counts is opening-to-opening)
//     range     — multiple of kickRange the phrase may open from
//     act       — 'punch' | 'kick'    press edge
//                 'charge'            press and hold `attack`; the strike is
//                                     thrown when the step ends, so `secs` IS
//                                     the visible coil the player blocks on
//                 'block'             stand guarding
//                 'advance'|'retreat' walk toward / away
//                 'sidestep'          one lateral step (`dir`)
//                 'wait'              stand still — a beat, and usually the
//                                     most readable part of a phrase
//
// Design rules, learned the hard way and worth keeping:
//   • Never randomise a phrase. Consistency is the whole feature — a varying
//     script is indistinguishable from the random layer it sits on top of.
//   • Open with a non-damaging beat (wait / retreat / sidestep / advance). The
//     tell has to arrive BEFORE the hit or there is nothing to react to.
//   • Give every phrase an interruptible moment. Landing a hit cancels it
//     (ai.js notifyHit), so a long commit is the player's reward for reading.
//   • Keep everySecs in the 4–7 s band: often enough to be noticed inside one
//     round, rare enough that the fight is not just the phrase on loop.
//   • Make the phrase echo the president's existing mechanic, so the tell and
//     the payoff teach the same lesson (Nixon's sneak sets up his dirty hits;
//     Truman's walk-in feeds the stack he builds by being hit).

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
    // SUPER — "THE WALL": banks current koStacks into a 3-second window of
    // (1 + koStacks × 0.05) damage on EVERY swing for the next 3 s. Visually
    // identical to the per-stack ramp but compressed into one dramatic burst.
    onSuper: { mode: 'theWall', durationSecs: 3.0 },
    // PATTERN — "the volley": two quick jabs, then the haymaker. The jabs are
    // cheap and land; the third is a long coil that hurts. The lesson is to
    // stop trading after the second — his haymaker chance already makes any
    // committed swing of his the dangerous one.
    aiPattern: {
      everySecs: 4.8, range: 1.15,
      steps: [
        { act: 'punch', secs: 0.26 },
        { act: 'punch', secs: 0.28 },
        { act: 'charge', attack: 'punch', secs: 0.75 },
      ],
    },
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
    // SUPER — "THE BIG GUY": guaranteed charged strike — auto-fills the energy
    // bar to CHARGE_MAX_MUL and arms the next punch/kick for the next 1.5 s
    // (no need to wind up by hand). The hit lands with the Biden slow effect.
    onSuper: { mode: 'bigGuy', lockSecs: 1.5 },
    // PATTERN — "the wind-up": a beat of stillness, then the longest single
    // coil in the roster. This is the phrase the old hardcoded Biden cadence
    // used to produce; the leading `wait` is new, and it is what turns a swing
    // that simply happened to you into one you can see coming.
    aiPattern: {
      everySecs: 5.5, range: 1.2,
      steps: [
        { act: 'wait', secs: 0.30 },
        { act: 'charge', attack: 'kick', secs: 1.0 },
      ],
    },
  },

  // ── Obama — "No-Drama Open" / "Drone Strike" combo ─────────────────
  // Counter-puncher: every ~4 s commits to a pre-planned jab→kick string.
  // Passive: 25% chance any incoming attack "misses" (heavy lean dodge).
  obama: {
    comboEverySecs: 4,
    comboIsPunchKick: true,
    passiveDodgeChance: 0.22,
    // SUPER — "DRONE STRIKE": 1.5 s of perfect iframes + next swing deals
    // 2.5× damage (the surgical strike). Plays a cool teal flicker on Obama.
    onSuper: { mode: 'droneStrike', iframesSecs: 1.5, nextSwingAtkMul: 2.5 },
    // PATTERN — "no drama": circle out, then the clean punch→kick string. The
    // sidestep is the tell and it also repositions him, so the answer is to
    // turn and guard low rather than swing at where he was.
    aiPattern: {
      everySecs: 4.4, range: 1.2,
      steps: [
        { act: 'sidestep', dir: -1, secs: 0.24 },
        { act: 'punch', secs: 0.30 },
        { act: 'kick', secs: 0.34 },
      ],
    },
  },

  // ── Bush (W.) — "Decider Mode" ─────────────────────────────────────
  // Mid-fight when HP drops below 40%, freezes for 1.5 s ("decision time")
  // then gains +40% damage and +15% speed for the remainder of the round.
  bush: {
    triggerOnce: true,
    checkHpBelow: 0.40,
    onTrigger: 'decider',
    onTriggerParams: { freezeSecs: 1.5, atkMul: 1.4, speedMul: 1.15 },
    // SUPER — "DECIDER MODE" (manual): same mode as the passive HP-gated
    // trigger, but fired on demand. No freeze window — straight into the
    // atkMul/speedMul buff for the rest of the round.
    onSuper: { mode: 'deciderManual', durationSecs: 30 },
    // PATTERN — "the decider": the longest dead stop in the game, then a fast
    // two-hit answer. Deliberately the mirror of Biden, who opens with a SHORT
    // pause into the longest coil: same opening beat, opposite payoff, so the
    // pair teaches the player to read what follows the pause rather than the
    // pause itself. The stop is free real estate — punish it and the answer
    // never comes. Rhymes with his passive freeze at 40% HP.
    aiPattern: {
      everySecs: 5.0, range: 1.15,
      steps: [
        { act: 'wait', secs: 0.70 },
        { act: 'punch', secs: 0.26 },
        { act: 'kick', secs: 0.32 },
      ],
    },
  },

  // ── Clinton — "Sax Solo" + "I Feel Your Pain" elbow flurry ─────────
  // Windup is 1.5× longer (the sax sway). Every successful hit chains into
  // a 4-jab elbow flurry whose count grows with the player's recent misses.
  clinton: {
    onSwingP: { saxSoloWindupMul: 1.5 },
    onHitChain: { name: 'feelYourPain', hits: 4, growthPerOppMiss: 1, growthCap: 6 },
    // SUPER — "SAX SOLO": arms a 1.6× next swing with auto-flurry chain
    // (4 hits). Same feel as the passive chain but the windup is doubled
    // (the visual tells the opponent a sax solo is coming).
    onSuper: { mode: 'saxSolo', nextSwingAtkMul: 1.6, chainHits: 4, saxSoloWindupMul: 2.0 },
    // PATTERN — "the sax sway": he rocks side to side, then swings. Two
    // sidesteps in opposite directions is a rhythm rather than a pose, which
    // suits a president whose whole gimmick is a 1.5× longer windup — you have
    // time to count the sway, and the swing it feeds chains into his flurry.
    aiPattern: {
      everySecs: 5.2, range: 1.2,
      steps: [
        { act: 'sidestep', dir: -1, secs: 0.22 },
        { act: 'sidestep', dir: 1, secs: 0.22 },
        { act: 'charge', attack: 'punch', secs: 0.60 },
      ],
    },
  },

  // ── Bush Sr. — "Read My Lips" + "Voodoo Economics" feints ──────────
  // Additive boosts to the AI table — he's the counter-fighter par excellence.
  // 30% of his windups become feints; blockers open up to guaranteed heavies.
  bushsr: {
    passiveAiBoost: { blockP: +0.12, punishP: +0.10, baitP: +0.30 },
    onFeintTrigger: 'counter',
    onCounterHitKBMul: 1.45,
    // SUPER — "VOODOO ECONOMICS": 1.2 s of guaranteed baits (the AI's
    // signature feint loop, but armed by the player as a human-only burst)
    // + next 3 swings carry 1.4× damage (the voodoo tax).
    onSuper: { mode: 'voodoo', feintSecs: 1.2, swingCount: 3, swingAtkMul: 1.4 },
    // PATTERN — "read my lips": a jab that is really bait, straight into guard,
    // then the counter the moment you answer it. He is the roster's counter-
    // fighter (+30% baitP), so his phrase punishes the reflex to trade. The
    // lesson is the opposite of everyone else's: do NOT swing at the opening.
    aiPattern: {
      everySecs: 4.6, range: 1.1,
      steps: [
        { act: 'punch', secs: 0.20 },
        { act: 'block', secs: 0.55 },
        { act: 'punch', secs: 0.30 },
      ],
    },
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
    // SUPER — "MORNING IN AMERICA" (manual): same buff as the passive HP-
    // gated mode but fired on demand. +40% dmg + 20% speed for 6 s, no HP
    // gate. Consumes the super meter even if HP is full.
    onSuper: { mode: 'morningInAmerica', atkMul: 1.4, speedMul: 1.2, durationSecs: 6 },
    // PATTERN — "tear down this wall": he plants and holds guard, inviting the
    // swing, then answers it. Pairs with his once-per-round reflect guard, so
    // the phrase teaches exactly the habit that his reflect punishes — hitting
    // a planted Reagan is how you lose health to your own attack.
    aiPattern: {
      everySecs: 5.6, range: 1.15,
      steps: [
        { act: 'block', secs: 0.95 },
        { act: 'kick', secs: 0.34 },
      ],
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
    // SUPER — "MALAISE SPEECH" (manual): 1.5 s iframes + the next landed hit
    // applies a 0.5 s slow (Carter's wagging-finger energy hits the defender).
    onSuper: { mode: 'malaiseSpeech', iframesSecs: 1.5, slowSecs: 0.5, slowMul: 0.55 },
    // PATTERN — "the finger wag": a beat to raise the finger, then four jabs on
    // an accelerating rhythm. No charge and no heavy — the threat is the ladder,
    // because his passive grows the combo by one for every hit he lands in a
    // row. Break the rhythm early and the ladder resets; let all four through
    // and the next phrase starts higher.
    //
    // The leading `wait` is not decoration. Every phrase needs its tell to
    // arrive before the first hit does, or there is nothing to react to — this
    // one opened on the jab and was the only phrase in the roster you could not
    // see coming.
    aiPattern: {
      everySecs: 5.0, range: 1.1,
      steps: [
        { act: 'wait', secs: 0.30 },
        { act: 'punch', secs: 0.30 },
        { act: 'punch', secs: 0.26 },
        { act: 'punch', secs: 0.22 },
        { act: 'punch', secs: 0.20 },
      ],
    },
  },

  // ── Ford — "Ford Stumble" + "Pardoning Nixon" ──────────────────────
  // 15% of his swings he trips on his own foot and self-stuns 0.6 s.
  // If the player hits him DURING the stumble, Ford retaliates with a
  // 2× damage window for 1.5 s (turn the stumble into a hidden buff).
  ford: {
    onSwingP: { stumbleChance: 0.15, stumbleSelfStunSecs: 0.6 },
    onStumbleHit: { retaliateDmgMul: 2.0, retaliateSecs: 1.5 },
    // SUPER — "PARDON ME": 1.0 s input-blind on the opponent (their block /
    // move inputs drop 60% of the time). Ford stumbles through the gap and
    // takes advantage.
    onSuper: { mode: 'pardonMe', blindSecs: 1.0, blindMissRate: 0.60 },
    // PATTERN — "the lurch": he barges in and throws a wild kick from too
    // close. Clumsy on purpose — the advance overshoots, and his 15% stumble
    // means the phrase sometimes collapses on its own. The read is that the
    // lurch is a free punish window if you step out instead of trading.
    aiPattern: {
      everySecs: 4.5, range: 1.35,
      steps: [
        { act: 'advance', secs: 0.40 },
        { act: 'kick', secs: 0.32 },
        { act: 'punch', secs: 0.28 },
      ],
    },
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
    // SUPER — "I AM NOT A CROOK": next 3 swings carry the dirty tag (ignore
    // 40% of block absorb) + the FIRST one applies 0.5 s opponent blind on
    // landing (a doubled-up eye-gouge for the meter cost).
    onSuper: { mode: 'notACrook', dirtySwings: 3, dirtyBlockFraction: 0.40, blindSecs: 0.5 },
    // PATTERN — "the sneak": he breaks off as though disengaging, then comes
    // straight back in. The retreat is the tell, and it is a trap for the
    // instinct to follow — chase him and you arrive exactly as the punch does.
    // Fits the president whose swings already ignore 40% of your block.
    aiPattern: {
      everySecs: 4.7, range: 1.25,
      steps: [
        { act: 'retreat', secs: 0.42 },
        { act: 'advance', secs: 0.22 },
        { act: 'punch', secs: 0.30 },
      ],
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
    // SUPER — "THE TREATMENT" (manual): primes an 8-second miss-charge window
    // (any opponent-miss within range → next LBJ swing +50% knockback).
    // The player CHOOSES when to arm it, instead of waiting passively.
    onSuper: { mode: 'treatmentManual', kbMul: 1.5, windowSecs: 8.0 },
    // PATTERN — "the treatment": he walks you down. Two advances with no guard
    // and no swing, closing until he is on top of you, then a heavy. The whole
    // phrase is pressure — and because his passive arms a +50% knockback swing
    // off any miss of yours, panicking into a swing as he crowds you is the
    // worst possible answer. Backing out beats it; swinging feeds it.
    aiPattern: {
      everySecs: 6.0, range: 1.6,
      steps: [
        { act: 'advance', secs: 0.35 },
        { act: 'advance', secs: 0.35 },
        { act: 'charge', attack: 'kick', secs: 0.55 },
      ],
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
    // SUPER — "PROFILES IN COURAGE" (manual): same effect as the time-gated
    // passive, but the player chooses when — and it's larger (0.6 s iframes
    // + next swing 1.5× damage instead of the passive 0.45 s / 1.25×).
    onSuper: { mode: 'profilesInCourage', iframesSecs: 0.6, nextSwingAtkMul: 1.5 },
    // PATTERN — "the dash": circle out, then back in from the other angle and
    // strike. The quickest phrase in the roster, matching the president whose
    // passive is a speed dash — you do not get long to read it, and every
    // fourth landed hit of his is a 1.4× Camelot Glint, so letting the string
    // connect repeatedly is how the round gets away from you.
    aiPattern: {
      everySecs: 4.2, range: 1.25,
      steps: [
        { act: 'sidestep', dir: 1, secs: 0.20 },
        { act: 'advance', secs: 0.18 },
        { act: 'punch', secs: 0.24 },
        { act: 'kick', secs: 0.28 },
      ],
    },
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
    // SUPER — "OPERATION OVERLORD": the next swing auto-lands at 2.2× damage
    // and grants 1.0 s of iframes immediately. The biggest one-shot swing
    // any president can buy with a super meter.
    onSuper: { mode: 'overlord', nextSwingAtkMul: 2.2, iframesSecs: 1.0 },
    // PATTERN — "Overlord": the longest preparation in the game. He guards,
    // then coils for a full 1.3 s before the swing lands. Slowest phrase, and
    // the one most worth blocking rather than dodging — his 1.5× windup /
    // 0.5× active frames mean the swing you block leaves him wide open.
    aiPattern: {
      everySecs: 6.5, range: 1.15,
      steps: [
        { act: 'block', secs: 0.45 },
        { act: 'charge', attack: 'punch', secs: 1.30 },
      ],
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
    // SUPER — "THE BUCK STOPS HERE": triplies the current buckStacks counter
    // for the next swing, then resets stacks to zero. The longer the player
    // let it build, the bigger the payoff — up to +180% dmg at cap.
    onSuper: { mode: 'buckStopsHere', stackMul: 3.0 },
    // PATTERN — "the buck stops here": he walks in with his hands down and
    // eats what you throw, then answers with a heavy. Standing still in range
    // and NOT guarding is the tell, and it is bait in the most literal sense —
    // every hit he takes adds +2% to that answering swing (up to +60%). The
    // counter-intuitive read: stop hitting Truman and let the phrase expire.
    aiPattern: {
      everySecs: 5.4, range: 1.4,
      steps: [
        { act: 'advance', secs: 0.35 },
        { act: 'wait', secs: 0.45 },
        { act: 'charge', attack: 'punch', secs: 0.65 },
      ],
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
    // SUPER — "DAY OF INFAMY" (manual): same +35% dmg buff as the HP-gated
    // mode, but fired on demand and lasting 8 s instead of 5. No HP gate.
    onSuper: { mode: 'dayOfInfamy', atkMul: 1.35, durationSecs: 8.0 },
    // PATTERN — "the fireside chat": he settles, pauses to address the room,
    // then reaches further than he should be able to. The stillness is the
    // tell and it lines up with his periodic 0.4 s iframe window, so swinging
    // into the pause is how you hit nothing; the kick that follows carries the
    // +25% reach, which is why spacing that felt safe suddenly is not.
    aiPattern: {
      everySecs: 6.0, range: 1.45,
      steps: [
        { act: 'block', secs: 0.30 },
        { act: 'wait', secs: 0.50 },
        { act: 'advance', secs: 0.20 },
        { act: 'kick', secs: 0.34 },
      ],
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
    // ── SUPER METER ───────────────────────────────────────────────────
    // Fills by taking damage (see game.js::_tickSuperMeter). When ≥ 1.0 the
    // player can press their Super key to fire onSuper. The super key is a
    // one-shot: firing consumes the meter to zero regardless of how full it
    // was, encouraging the player to time the activation, not stockpile.
    superMeter: 0,
    // superUntil removed 2026-08-11 — it only ever drove the HUD's "PRESS SUPER"
    // flash, and the super bar it flashed on is gone. Nothing read it otherwise.
    superActiveMode: null,      // mode name currently being delivered (for AI + UI)
    superFiredAt: 0,            // wall-clock t when last fired (preventing AI back-to-back spam)
    // Per-super scratch state slots — each president's on-super writes here.
    superSwingAtkMul: 1.0,      // obama drone strike, clinton sax solo, jfk profile, eisenhower overlord
    superDirtySwingsLeft: 0,    // nixon notACrook — swings remaining carrying dirty tag
    superPumpSwingsLeft: 0,     // bushsr voodoo — swings remaining with voodoo tax
    superSwingCnt: 0,           // generic swing counter for swing-counted supers (nixon/bushsr)
  };
}
