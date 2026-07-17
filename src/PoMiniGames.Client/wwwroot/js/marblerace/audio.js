// audio.js — procedural Web Audio for PoMarbleRace. No asset files: everything is synthesized
// from oscillators and noise buffers.
//
// The race used to be almost silent — three one-shot sounds, and impact clinks gated so hard
// that most of a run had no audio at all. The soundscape is now continuous: a rolling bed that
// tracks the leader's speed, a crowd that swells toward the finish, and one-shots layered on
// top (countdown, gun, boost, overtake, finish, result). Everything routes through `master`
// so mute is one gain, not a flag checked in eight places.

const NOISE_SECONDS = 2;

export function createAudio() {
  let ctx = null;
  let muted = false;
  let lastClink = 0;
  let lastOvertake = 0;

  // Graph nodes, built lazily on first ensure(). Null until then.
  let master = null;
  let rollSrc = null, rollFilter = null, rollGain = null;
  let crowdSrc = null, crowdFilter = null, crowdGain = null;
  let noiseBuf = null;

  function makeNoise(c) {
    const buf = c.createBuffer(1, c.sampleRate * NOISE_SECONDS, c.sampleRate);
    const d = buf.getChannelData(0);
    // Brownian-ish noise: cheaper than true pink, and the low-frequency weighting is what
    // makes it read as "rumble" and "crowd" rather than as a hiss.
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3.5;
    }
    return buf;
  }

  function buildBeds(c) {
    noiseBuf = makeNoise(c);

    // Rolling bed: noise through a bandpass whose frequency rides marble speed.
    rollSrc = c.createBufferSource();
    rollSrc.buffer = noiseBuf;
    rollSrc.loop = true;
    rollFilter = c.createBiquadFilter();
    rollFilter.type = 'bandpass';
    rollFilter.frequency.value = 220;
    rollFilter.Q.value = 1.1;
    rollGain = c.createGain();
    rollGain.gain.value = 0;
    rollSrc.connect(rollFilter).connect(rollGain).connect(master);
    rollSrc.start();

    // Crowd bed: the same noise, lowpassed hard and swelled as the race resolves.
    crowdSrc = c.createBufferSource();
    crowdSrc.buffer = noiseBuf;
    crowdSrc.loop = true;
    crowdFilter = c.createBiquadFilter();
    crowdFilter.type = 'lowpass';
    crowdFilter.frequency.value = 900;
    crowdFilter.Q.value = 0.7;
    crowdGain = c.createGain();
    crowdGain.gain.value = 0;
    crowdSrc.connect(crowdFilter).connect(crowdGain).connect(master);
    crowdSrc.start();
  }

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(ctx.destination);
      buildBeds(ctx);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // ── Continuous beds ───────────────────────────────────────────────────
  // Called every frame from the game loop. `speed` is the focused marble's speed;
  // `nearFinish` (0..1) drives the crowd swell.
  function updateBeds(speed, nearFinish, racing) {
    if (!ctx || !rollGain) return;
    const now = ctx.currentTime;
    const v = Math.min(1, Math.max(0, speed / 45));
    // Ramp rather than set: a per-frame setValueAtTime on a gain is a zipper-noise generator.
    const rollTarget = racing ? 0.02 + v * 0.16 : 0;
    rollGain.gain.setTargetAtTime(rollTarget, now, 0.08);
    rollFilter.frequency.setTargetAtTime(140 + v * 620, now, 0.08);

    const crowdTarget = racing ? 0.015 + Math.max(0, Math.min(1, nearFinish)) * 0.13 : 0.01;
    crowdGain.gain.setTargetAtTime(crowdTarget, now, 0.25);
    crowdFilter.frequency.setTargetAtTime(600 + Math.max(0, Math.min(1, nearFinish)) * 1400, now, 0.25);
  }

  function silenceBeds() {
    if (!ctx || !rollGain) return;
    const now = ctx.currentTime;
    rollGain.gain.setTargetAtTime(0, now, 0.1);
    crowdGain.gain.setTargetAtTime(0, now, 0.1);
  }

  // ── One-shots ─────────────────────────────────────────────────────────
  function tone(freq, start, dur, peak, type, endFreq) {
    const c = ctx;
    if (!c) return;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, start);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, start + dur);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  // A short metallic clink. volume/pitch scale with impact speed.
  function playClink(speed) {
    const c = ensure();
    if (!c) return;
    const now = c.currentTime;
    if (now - lastClink < 0.02) return; // throttle spam
    lastClink = now;

    const v = Math.min(1, speed / 22);
    const freq = 320 + v * 900;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.6, now + 0.08);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.05 + v * 0.18, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(gain).connect(master);
    osc.start(now);
    osc.stop(now + 0.14);
  }

  // Countdown pip. `final` is the go tone — higher and longer.
  function playBeep(final) {
    const c = ensure();
    if (!c) return;
    tone(final ? 1046.5 : 660, c.currentTime + 0.01, final ? 0.22 : 0.09, 0.14, 'square');
  }

  // Starting gun: a noise crack through a fast-decaying highpass.
  function playGun() {
    const c = ensure();
    if (!c || !noiseBuf) return;
    const now = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 800;
    const g = c.createGain();
    g.gain.setValueAtTime(0.5, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    src.connect(hp).connect(g).connect(master);
    src.start(now);
    src.stop(now + 0.25);
    tone(90, now, 0.18, 0.3, 'sine', 40); // body thump under the crack
  }

  // Boost pad: a rising whoosh.
  function playWhoosh() {
    const c = ensure();
    if (!c) return;
    tone(240, c.currentTime + 0.01, 0.26, 0.09, 'sawtooth', 900);
  }

  // Overtake: a two-note blip. Throttled — the pack trades places constantly in
  // traffic and an unthrottled cue turns into a machine gun.
  function playOvertake(gained) {
    const c = ensure();
    if (!c) return;
    const now = c.currentTime;
    if (now - lastOvertake < 0.5) return;
    lastOvertake = now;
    const a = gained ? 587.33 : 466.16;
    const b = gained ? 880.0 : 349.23;
    tone(a, now + 0.01, 0.09, 0.1, 'square');
    tone(b, now + 0.09, 0.11, 0.1, 'square');
  }

  // Finish chime for a marble crossing the line.
  function playFinish() {
    const c = ensure();
    if (!c) return;
    const now = c.currentTime;
    tone(880, now + 0.01, 0.13, 0.11, 'triangle');
    tone(1318.5, now + 0.07, 0.16, 0.09, 'triangle');
  }

  // Win = rising triad, lose = falling minor.
  function playSting(win) {
    const c = ensure();
    if (!c) return;
    const t = c.currentTime + 0.02;
    const notes = win ? [523.25, 659.25, 783.99] : [392.0, 311.13, 261.63];
    notes.forEach((f, i) => tone(f, t + i * 0.12, 0.28, 0.16, 'square'));
  }

  function applyMute() {
    if (!master || !ctx) return;
    master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.02);
  }

  return {
    resume() { ensure(); },
    playClink,
    playSting,
    playBeep,
    playGun,
    playWhoosh,
    playOvertake,
    playFinish,
    updateBeds,
    silenceBeds,
    setMuted(m) { muted = !!m; applyMute(); },
    toggleMuted() { muted = !muted; applyMute(); return muted; },
    isMuted() { return muted; },
    dispose() {
      if (ctx) {
        try { rollSrc && rollSrc.stop(); } catch { }
        try { crowdSrc && crowdSrc.stop(); } catch { }
        try { ctx.close(); } catch { }
        ctx = null; master = null; rollSrc = null; crowdSrc = null; rollGain = null; crowdGain = null;
      }
    },
  };
}
