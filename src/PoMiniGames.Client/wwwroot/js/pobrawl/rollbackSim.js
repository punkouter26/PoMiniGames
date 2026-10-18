// rollbackSim.js — the online fight's rules as a pure, integer-only, 60 Hz frame step.
//
// This is the JavaScript twin of PoMiniGames.Shared/Games/PoBrawlRollbackSim.cs, and the two must
// stay BIT-IDENTICAL: the same state and inputs give the same next state and the same checksum in
// both. The server referees the fight with the C# copy; each browser predicts and rolls back with
// this one (rollbackSession.js). A golden input script pins the final checksum on both sides
// (tests/pobrawl-rollback.test.mjs and the C# PoBrawlMatchServiceTests scenario), so change a rule
// here and there in the same commit, and update the golden number in both tests.
//
// Integer discipline: every value is a small int. Division goes through `| 0` (truncation, like C#),
// the RNG through Math.imul and `>>> 0` (uint32 wrap, like C# unchecked uint). No floats.
//
// Units: millimetres, sixths of an energy point (ENERGY_SCALE), frames at 60 Hz.

export const HZ = 60;
export const FRAME_MS = 1000 / HZ;
export const INPUT_DELAY = 2;
export const ROUND_FRAMES = 60 * HZ;
export const MAX_HP = 100;

export const RING_HALF_MM = 5200;
export const SPAWN_X_MM = 1600;
export const MIN_GAP_MM = 950;
export const WALK_IN_MM = 40;
export const WALK_OUT_MM = 32;

export const PUNCH_REACH_MM = 1500;
export const KICK_REACH_MM = 1750;
export const SPECIAL_REACH_MM = 1750;

export const PUNCH_KNOCKBACK_MM = 150;
export const KICK_KNOCKBACK_MM = 450;
export const SPECIAL_KNOCKBACK_MM = 900;

export const PUNCH_COOLDOWN = 18;
export const KICK_COOLDOWN = 30;
export const SPECIAL_COOLDOWN = 48;

export const ENERGY_SCALE = 6;
export const ENERGY_MAX = 100 * ENERGY_SCALE;
export const ENERGY_REGEN_IDLE = 2;
export const ENERGY_REGEN_WALK = 1;
export const PUNCH_ENERGY_COST = 3 * ENERGY_SCALE;
export const KICK_ENERGY_COST = 6 * ENERGY_SCALE;
export const ENERGY_ON_HIT = 6 * ENERGY_SCALE;

export const PUNCH_DAMAGE = 6;
export const KICK_DAMAGE = 10;
export const SPECIAL_DAMAGE = 18;
export const DAMAGE_VARIANCE_PCT = 20;

export const HELD_IDLE = 0, HELD_FORWARD = 1, HELD_BACK = 2, HELD_BLOCK = 3;
export const PRESS_NONE = 0, PRESS_PUNCH = 4, PRESS_KICK = 5, PRESS_SPECIAL = 6;
export const OUTCOME_NONE = 0, OUTCOME_HIT = 1, OUTCOME_BLOCKED = 2, OUTCOME_WHIFF = 3;
export const REASON_NONE = 0, REASON_KO = 1, REASON_TIME = 2;

export const PACKED_LENGTH = 26;

function newCorner(x) {
  return { hp: MAX_HP, energy: 0, x, held: HELD_IDLE, pending: PRESS_NONE, cooldown: 0, swingFrame: -1, swing: 0, outcome: 0, damage: 0 };
}

/** A fresh fight: both corners on their marks, `fightStart` frames of pre-roll. */
export function createState(seed, fightStart) {
  return { frame: 0, fightStart: fightStart | 0, rng: seed | 0, over: 0, winner: 0, reason: 0, p1: newCorner(-SPAWN_X_MM), p2: newCorner(SPAWN_X_MM) };
}

export function cloneState(s) {
  return { frame: s.frame, fightStart: s.fightStart, rng: s.rng, over: s.over, winner: s.winner, reason: s.reason, p1: { ...s.p1 }, p2: { ...s.p2 } };
}

/** FNV-1a over the id's UTF-16 code units (C# SeedFromMatchId). Unsigned. */
export function seedFromMatchId(matchId) {
  let h = 2166136261;
  for (let i = 0; i < matchId.length; i++) h = Math.imul(h ^ matchId.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** mulberry32: advances holder.rng, returns the next 32 bits unsigned. */
export function nextRandom(holder) {
  const a = (holder.rng + 0x6D2B79F5) | 0;
  holder.rng = a;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
}

/** One input event as an int: 0 = none; bits 0–2 hold held+1 (0 = unchanged), bits 3–5 the press. */
export function encodeInput(held, press) { return ((held + 1) | (press << 3)) | 0; }
export function heldOf(input) { return (input & 7) - 1; }
export function pressOf(input) { return (input >> 3) & 7; }

/** Two events on one frame: the later one's held if it set one, its press if it pressed. */
export function mergeInput(earlier, later) {
  const held = (later & 7) !== 0 ? later & 7 : earlier & 7;
  const press = pressOf(later) !== 0 ? pressOf(later) : pressOf(earlier);
  return held | (press << 3);
}

export function elapsedSeconds(s) { return (s.frame - s.fightStart) / HZ; }

function applyInput(c, input) {
  if (input === 0) return;
  const held = heldOf(input);
  if (held >= HELD_IDLE && held <= HELD_BLOCK) c.held = held;
  const press = pressOf(input);
  if (press >= PRESS_PUNCH && press <= PRESS_SPECIAL) c.pending = press;
}

function walkStep(held) {
  return held === HELD_FORWARD ? WALK_IN_MM : held === HELD_BACK ? -WALK_OUT_MM : 0;
}

function regen(c) {
  const r = c.held === HELD_IDLE ? ENERGY_REGEN_IDLE
    : (c.held === HELD_FORWARD || c.held === HELD_BACK) ? ENERGY_REGEN_WALK : 0;
  c.energy = Math.min(ENERGY_MAX, c.energy + r);
  if (c.cooldown > 0) c.cooldown--;
}

function takeSwing(c) {
  const swing = c.pending;
  if (swing === PRESS_NONE || c.cooldown > 0) return PRESS_NONE;
  c.pending = PRESS_NONE;
  if (swing === PRESS_SPECIAL && c.energy < ENERGY_MAX) return PRESS_NONE;
  if (swing === PRESS_PUNCH) {
    c.cooldown = PUNCH_COOLDOWN;
    c.energy = Math.max(0, c.energy - PUNCH_ENERGY_COST);
  } else if (swing === PRESS_KICK) {
    c.cooldown = KICK_COOLDOWN;
    c.energy = Math.max(0, c.energy - KICK_ENERGY_COST);
  } else {
    c.cooldown = SPECIAL_COOLDOWN;
    c.energy = 0;
  }
  return swing;
}

function resolveSwing(s, attacker, defender, swing, guarded, gap, shoveDir) {
  let baseDmg, reach, knockback;
  if (swing === PRESS_PUNCH) { baseDmg = PUNCH_DAMAGE; reach = PUNCH_REACH_MM; knockback = PUNCH_KNOCKBACK_MM; }
  else if (swing === PRESS_KICK) { baseDmg = KICK_DAMAGE; reach = KICK_REACH_MM; knockback = KICK_KNOCKBACK_MM; }
  else { baseDmg = SPECIAL_DAMAGE; reach = SPECIAL_REACH_MM; knockback = SPECIAL_KNOCKBACK_MM; }
  attacker.swingFrame = s.frame;
  attacker.swing = swing;
  attacker.damage = 0;
  if (gap > reach) {
    attacker.outcome = OUTCOME_WHIFF;
    return;
  }
  const variance = (nextRandom(s) % (2 * DAMAGE_VARIANCE_PCT + 1)) - DAMAGE_VARIANCE_PCT;
  let damage = ((baseDmg * (100 + variance) + 50) / 100) | 0;
  if (guarded) {
    damage = swing === PRESS_PUNCH ? 0 : swing === PRESS_KICK ? Math.max(1, (damage / 4) | 0) : damage;
    knockback = (knockback / 2) | 0;
  }
  defender.x += shoveDir * knockback;
  attacker.outcome = guarded ? OUTCOME_BLOCKED : OUTCOME_HIT;
  if (damage <= 0) return;
  const dealt = Math.min(defender.hp, damage);
  defender.hp -= dealt;
  attacker.damage = dealt;
  attacker.energy = Math.min(ENERGY_MAX, attacker.energy + ENERGY_ON_HIT);
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function enforceSpacing(s) {
  s.p1.x = clamp(s.p1.x, -RING_HALF_MM, RING_HALF_MM - MIN_GAP_MM);
  s.p2.x = clamp(s.p2.x, -RING_HALF_MM + MIN_GAP_MM, RING_HALF_MM);
  const deficit = MIN_GAP_MM - (s.p2.x - s.p1.x);
  if (deficit <= 0) return;
  const p1Room = s.p1.x + RING_HALF_MM;
  const p2Room = RING_HALF_MM - s.p2.x;
  let p1Share = Math.min(p1Room, (deficit / 2) | 0);
  const p2Share = Math.min(p2Room, deficit - p1Share);
  p1Share = Math.min(p1Room, deficit - p2Share);
  s.p1.x -= p1Share;
  s.p2.x += p2Share;
}

/** Advance `s` one frame IN PLACE with each corner's input event (0 = none). */
export function step(s, input1, input2) {
  s.frame++;
  if (s.over !== 0) return s;
  applyInput(s.p1, input1);
  applyInput(s.p2, input2);
  if (s.frame <= s.fightStart) {
    s.p1.pending = PRESS_NONE;
    s.p2.pending = PRESS_NONE;
    return s;
  }
  const gap = s.p2.x - s.p1.x;
  const a1 = takeSwing(s.p1);
  const a2 = takeSwing(s.p2);
  const p1Guarding = a1 === PRESS_NONE && s.p1.held === HELD_BLOCK;
  const p2Guarding = a2 === PRESS_NONE && s.p2.held === HELD_BLOCK;
  if (a1 !== PRESS_NONE) { resolveSwing(s, s.p1, s.p2, a1, p2Guarding, gap, 1); enforceSpacing(s); }
  if (a2 !== PRESS_NONE) { resolveSwing(s, s.p2, s.p1, a2, p1Guarding, gap, -1); enforceSpacing(s); }
  if (a1 === PRESS_NONE) s.p1.x += walkStep(s.p1.held);
  if (a2 === PRESS_NONE) s.p2.x -= walkStep(s.p2.held);
  enforceSpacing(s);
  regen(s.p1);
  regen(s.p2);
  if (s.p1.hp <= 0) { s.over = 1; s.winner = 2; s.reason = REASON_KO; }
  else if (s.p2.hp <= 0) { s.over = 1; s.winner = 1; s.reason = REASON_KO; }
  else if (s.frame - s.fightStart >= ROUND_FRAMES) {
    s.over = 1;
    s.winner = s.p1.hp > s.p2.hp ? 1 : s.p2.hp > s.p1.hp ? 2 : 0;
    s.reason = REASON_TIME;
  }
  return s;
}

function packCorner(a, o, c) {
  a[o] = c.hp; a[o + 1] = c.energy; a[o + 2] = c.x; a[o + 3] = c.held; a[o + 4] = c.pending;
  a[o + 5] = c.cooldown; a[o + 6] = c.swingFrame; a[o + 7] = c.swing; a[o + 8] = c.outcome; a[o + 9] = c.damage;
}

function unpackCorner(a, o) {
  return { hp: a[o] | 0, energy: a[o + 1] | 0, x: a[o + 2] | 0, held: a[o + 3] | 0, pending: a[o + 4] | 0,
    cooldown: a[o + 5] | 0, swingFrame: a[o + 6] | 0, swing: a[o + 7] | 0, outcome: a[o + 8] | 0, damage: a[o + 9] | 0 };
}

/** The wire layout (C# PoBrawlRollbackSim.Pack). */
export function pack(s) {
  const a = new Array(PACKED_LENGTH);
  a[0] = s.frame; a[1] = s.fightStart; a[2] = s.rng; a[3] = s.over; a[4] = s.winner; a[5] = s.reason;
  packCorner(a, 6, s.p1);
  packCorner(a, 16, s.p2);
  return a;
}

export function unpack(a) {
  if (!a || a.length !== PACKED_LENGTH) throw new Error(`rollbackSim: expected ${PACKED_LENGTH} ints`);
  return { frame: a[0] | 0, fightStart: a[1] | 0, rng: a[2] | 0, over: a[3] | 0, winner: a[4] | 0, reason: a[5] | 0,
    p1: unpackCorner(a, 6), p2: unpackCorner(a, 16) };
}

/** FNV-1a over the packed ints, one 32-bit word at a time. Unsigned. */
export function checksum(s) {
  let h = 2166136261;
  for (const v of pack(s)) h = Math.imul(h ^ v, 16777619);
  return h >>> 0;
}

export function statesEqual(a, b) {
  const pa = pack(a), pb = pack(b);
  for (let i = 0; i < PACKED_LENGTH; i++) if (pa[i] !== pb[i]) return false;
  return true;
}
