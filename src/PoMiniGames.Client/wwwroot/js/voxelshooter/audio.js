// audio.js — Voxel Shooter SFX.
// Web Audio API tones only — no <audio> tags (AGENT.MD convention) and no
// shipped assets. AudioContext is created lazily on first call so mobile
// autoplay rules are respected.

let _ctx = null;
let _muted = false;

async function ensureCtx() {
  if (_ctx) return _ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  _ctx = new Ctor();
  if (_ctx.state === 'suspended') {
    try { await _ctx.resume(); } catch { /* gesture not yet provided */ }
  }
  return _ctx;
}

/**
 * Play a single tone with a linear attack and exponential decay.
 * @param {number} freq
 * @param {number} ms
 * @param {number} gain 0..1
 * @param {OscillatorType} [type]
 */
export async function tone(freq, ms, gain, type = 'square') {
  if (_muted) return;
  try {
    const ctx = await ensureCtx();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const dur = Math.max(0.01, ms / 1000);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch { /* audio not available */ }
}

/** Play several tones simultaneously (cheap chord). */
export async function chord(freqs, ms, gain, type = 'triangle') {
  for (const f of freqs) tone(f, ms, gain, type);
}

/**
 * Slide a tone from f0 → f1 over the duration. Useful for powerup pickups
 * and the "wave complete" stinger.
 */
export async function sweep(f0, f1, ms, gain, type = 'sine') {
  if (_muted) return;
  try {
    const ctx = await ensureCtx();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const dur = Math.max(0.02, ms / 1000);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch { /* silent */ }
}

// ── Curated SFX ────────────────────────────────────────────────────────
// Frequencies are musical (A4 = 440) so together they sound like a chiptune
// score instead of random beeps. Volumes are tuned to be assertive without
// being abrasive when a full wave clears.
export const sfx = {
  shoot:        () => tone(880, 50, 0.04, 'square'),
  enemyHit:     () => tone(180, 60, 0.06, 'sawtooth'),
  enemyKill:    () => chord([660, 990], 90, 0.06, 'triangle'),
  playerHurt:   () => chord([110, 100], 240, 0.12, 'square'),
  terrainHit:   () => sweep(420, 110, 120, 0.05, 'square'),
  powerUp:      () => sweep(440, 1320, 180, 0.06, 'triangle'),
  powerDown:    () => sweep(660, 220, 200, 0.05, 'sine'),
  waveStart:    () => chord([523, 659, 784], 280, 0.07, 'triangle'),
  waveWin:      () => chord([659, 784, 988, 1319], 350, 0.08, 'triangle'),
  shopBuy:      () => tone(1200, 80, 0.05, 'sine'),
  nuke:         () => sweep(110, 55, 600, 0.16, 'sine'),
  shieldBlock:  () => chord([880, 1320, 880], 100, 0.06, 'sine'),
};

export function setMuted(muted) { _muted = !!muted; }
export function isMuted() { return _muted; }
