// audio.js — synthesized audio bus for PoBrawl.
// No audio files; everything is generated from OscillatorNode + filtered noise.
// Architecture:
//   master gain -> dynamics compressor -> destination
//     ├── sfxGain       (impacts, blocks, KO, voice grunts, footsteps)
//     │     └── panner (per source; falls back to stereo gain if no PannerNode)
//     └── musicGain     (round-start loop stem + low-HP crossfade)
//
// Every public method is a no-op while muted so the game can call them freely.

const NOISE_BUFFER_SIZE = 44100; // ~1 second of pink-ish noise, reused

function makeNoiseBuffer(ctx) {
  const buf = ctx.createBuffer(1, NOISE_BUFFER_SIZE, ctx.sampleRate);
  const data = buf.getChannelData(0);
  // Simple low-passed white noise — closer to "thud" than harsh hiss.
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.15 * white) / 1.15;
    data[i] = last;
  }
  return buf;
}

// Lazy AudioContext + master bus; we never start audio without a user gesture,
// but the bus itself can be created on first call.
class AudioBus {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.master = null;
    this.sfxGain = null;
    this.musicGain = null;
    this.musicLowGain = null;
    this.noiseBuf = null;
    this.musicNodes = null;
    this.lowMusicCrossfade = 0; // 0 = normal stem, 1 = low-HP stem
    // Audio-reactive envelope. Each SFX call nudges this up; the render loop
    // calls tick(dt) once a frame to decay it. The BrawlGame reads
    // getEnvelope() to pulse the UnrealBloomPass on every impact.
    this._env = 0;
    this._envPeak = 1.0; // clamped ceiling for the latest hit
  }

  _ensure() {
    if (this.ctx) return true;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return false;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.85;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.18;
      this.master.connect(comp).connect(this.ctx.destination);
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 1.0;
      this.sfxGain.connect(this.master);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.35;
      this.musicGain.connect(this.master);
      this.musicLowGain = this.ctx.createGain();
      this.musicLowGain.gain.value = 0;
      this.musicLowGain.connect(this.master);
      this.noiseBuf = makeNoiseBuffer(this.ctx);
      return true;
    } catch {
      return false;
    }
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.85;
  }

  // Audio-reactive envelope: every SFX method calls _pulse(power) right when
  // the sound fires, so the bloom pass in game.js can read getEnvelope() the
  // same frame. Big hits land at ~1.0, whooshes at ~0.2, blocks at ~0.4.
  _pulse(power) {
    this._envPeak = Math.max(this._envPeak, Math.min(1, power));
  }

  // Per-frame envelope decay. Halflife ≈ 90 ms so a flurry of hits keeps
  // the bloom glowing; silence brings it back to zero in ~0.5 s.
  tick(dt) {
    const decay = Math.exp(-dt * 7.5);
    this._env = this._envPeak * (1 - decay) + this._env * decay;
    // After enough decay, both targets converge; collapse _envPeak so a new
    // pulse doesn't get averaged into the tail of a previous one.
    if (this._env < 0.01 && this._envPeak < 0.01) { this._env = 0; this._envPeak = 0; }
  }

  getEnvelope() { return this._env; }

  // Resume the context after a user gesture — Blazor can't always start audio
  // because the .razor lifecycle may not be triggered by a button click.
  async resume() {
    if (this._ensure() && this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* noop */ }
    }
  }

  // Helper: get or create a one-shot panner; falls back to a stereo gain node.
  _spatializer(pannerXYZ) {
    const ctx = this.ctx;
    let node;
    if (ctx.listener && ctx.createPanner) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 2;
      p.maxDistance = 18;
      p.rolloffFactor = 1.4;
      if (pannerXYZ) {
        p.positionX.value = pannerXYZ.x;
        p.positionY.value = pannerXYZ.y || 0;
        p.positionZ.value = pannerXYZ.z;
      }
      node = p;
    } else {
      // Fallback: fake spatial via equal-power pan based on world-x.
      const gain = ctx.createGain();
      const x = pannerXYZ ? Math.max(-1, Math.min(1, pannerXYZ.x / 6)) : 0;
      gain.gain.value = 1;
      node = gain;
    }
    return node;
  }

  // Layered impact: low thud (sine + sub noise) + mid crack (filtered noise) + hiss.
  impact({ power = 1, blocked = false, worldPos = null } = {}) {
    if (!this._ensure() || this.muted) return;
    this._pulse(blocked ? 0.45 : Math.min(1, 0.55 + power * 0.25));
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._spatializer(worldPos);
    spat.connect(this.sfxGain);

    // 1. Body thud (sine 70-110 Hz, fast decay).
    const thud = ctx.createOscillator();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(blocked ? 180 : 95 + power * 35, now);
    thud.frequency.exponentialRampToValueAtTime(45, now + 0.08);
    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0, now);
    thudGain.gain.linearRampToValueAtTime(blocked ? 0.18 : 0.34, now + 0.005);
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    thud.connect(thudGain).connect(spat);
    thud.start(now); thud.stop(now + 0.22);

    // 2. Crack (bandpass noise burst).
    if (!blocked) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800 + power * 600;
      bp.Q.value = 1.4;
      const crackGain = ctx.createGain();
      crackGain.gain.setValueAtTime(0, now);
      crackGain.gain.linearRampToValueAtTime(0.22 + power * 0.05, now + 0.004);
      crackGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      src.connect(bp).connect(crackGain).connect(spat);
      src.start(now); src.stop(now + 0.08);
    }

    // 3. Hiss tail (highpass noise).
    const tail = ctx.createBufferSource();
    tail.buffer = this.noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 4000;
    const tailGain = ctx.createGain();
    tailGain.gain.setValueAtTime(0, now);
    tailGain.gain.linearRampToValueAtTime(blocked ? 0.04 : 0.10, now + 0.01);
    tailGain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    tail.connect(hp).connect(tailGain).connect(spat);
    tail.start(now); tail.stop(now + 0.28);
  }

  block(worldPos = null) {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.4);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._spatializer(worldPos);
    spat.connect(this.sfxGain);

    // Wooden "tap" — two short triangle hits.
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 240 - i * 40;
      const g = ctx.createGain();
      const t0 = now + i * 0.05;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.15, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.07);
      o.connect(g).connect(spat);
      o.start(t0); o.stop(t0 + 0.09);
    }
  }

  ko() {
    this._pulse(1.0);
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // Sub-bass thud + slow down sweep + crash noise.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(140, now);
    sub.frequency.exponentialRampToValueAtTime(28, now + 0.9);
    const subG = ctx.createGain();
    subG.gain.setValueAtTime(0, now);
    subG.gain.linearRampToValueAtTime(0.6, now + 0.02);
    subG.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
    sub.connect(subG).connect(this.sfxGain);
    sub.start(now); sub.stop(now + 1.25);

    const crash = ctx.createBufferSource();
    crash.buffer = this.noiseBuf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    const cG = ctx.createGain();
    cG.gain.setValueAtTime(0, now);
    cG.gain.linearRampToValueAtTime(0.35, now + 0.04);
    cG.gain.exponentialRampToValueAtTime(0.001, now + 1.0);
    crash.connect(lp).connect(cG).connect(this.sfxGain);
    crash.start(now); crash.stop(now + 1.05);
  }

  // Short vocal grunt on swing / windup. Random pitch so it doesn't loop.
  grunt({ power = 1, blocked = false } = {}) {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.15 + power * 0.1);
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const baseHz = blocked ? 150 : 110 + power * 30;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(baseHz, now);
    o.frequency.exponentialRampToValueAtTime(baseHz * 0.55, now + 0.18);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = baseHz * 2;
    bp.Q.value = 5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.08, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    o.connect(bp).connect(g).connect(this.sfxGain);
    o.start(now); o.stop(now + 0.25);
  }

  whoosh() {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.22);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(800, now);
    bp.frequency.linearRampToValueAtTime(2200, now + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.06, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    src.connect(bp).connect(g).connect(this.sfxGain);
    src.start(now); src.stop(now + 0.25);
  }

  // Cheap footstep tick — call on every other walk-cycle hit.
  footstep(volume = 0.05) {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.08);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 90;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(volume, now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    o.connect(g).connect(this.sfxGain);
    o.start(now); o.stop(now + 0.09);
  }

  // Continuous music stem: two layered loops we crossfade between based on HP.
  // No samples, so we synthesize a simple 4-step bass + filtered noise pad.
  startMusic() {
    if (!this._ensure() || this.musicNodes) return;
    const ctx = this.ctx;
    const tempo = 96; // bpm
    const beat = 60 / tempo;
    const bar = beat * 4;

    // Bass sequencer.
    const bassNotes = [55, 55, 73, 65]; // A1, A1, D2, C2 (A minor pentatonic)
    let step = 0;
    const bassNode = ctx.createOscillator();
    bassNode.type = 'triangle';
    const bassGain = ctx.createGain();
    bassGain.gain.value = 0;
    const bassLP = ctx.createBiquadFilter();
    bassLP.type = 'lowpass';
    bassLP.frequency.value = 700;
    bassNode.connect(bassLP).connect(bassGain).connect(this.musicGain);
    bassNode.start();

    const tickBass = () => {
      if (this.musicNodes?.stopped) return;
      const now = ctx.currentTime;
      const freq = bassNotes[step % bassNotes.length];
      bassNode.frequency.setValueAtTime(freq, now);
      bassGain.gain.cancelScheduledValues(now);
      bassGain.gain.setValueAtTime(0, now);
      bassGain.gain.linearRampToValueAtTime(0.22, now + 0.01);
      bassGain.gain.exponentialRampToValueAtTime(0.001, now + beat * 0.85);
      step++;
    };
    const bassInterval = setInterval(tickBass, beat * 1000);
    tickBass();

    // Pad: filtered noise with a slow LFO on cutoff — feels like a crowd murmur.
    const pad = ctx.createBufferSource();
    pad.buffer = this.noiseBuf;
    pad.loop = true;
    const padLP = ctx.createBiquadFilter();
    padLP.type = 'lowpass';
    padLP.frequency.value = 600;
    const padGain = ctx.createGain();
    padGain.gain.value = 0.04;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.18;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 250;
    lfo.connect(lfoGain).connect(padLP.frequency);
    pad.connect(padLP).connect(padGain).connect(this.musicGain);
    pad.start(); lfo.start();

    this.musicNodes = {
      bassNode, bassGain, bassInterval, pad, lfo, padGain,
      stopped: false,
    };
  }

  // 0..1 — how much to crossfade the music toward the "low-HP" stem.
  // We simulate the low-HP stem by attenuating the bass + brightening the pad.
  setMusicTension(t) {
    this.lowMusicCrossfade = Math.max(0, Math.min(1, t));
    if (!this.musicNodes || !this._ensure()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.musicNodes.bassGain.gain.cancelScheduledValues(now);
    this.musicNodes.bassGain.gain.linearRampToValueAtTime(0.22 - 0.16 * this.lowMusicCrossfade, now + 0.4);
    this.musicNodes.padGain.gain.cancelScheduledValues(now);
    this.musicNodes.padGain.gain.linearRampToValueAtTime(0.04 + 0.06 * this.lowMusicCrossfade, now + 0.4);
  }

  stopMusic() {
    if (!this.musicNodes) return;
    this.musicNodes.stopped = true;
    clearInterval(this.musicNodes.bassInterval);
    try { this.musicNodes.bassNode.stop(); } catch { /* */ }
    try { this.musicNodes.pad.stop(); } catch { /* */ }
    try { this.musicNodes.lfo.stop(); } catch { /* */ }
    this.musicNodes = null;
  }

  close() {
    this.stopMusic();
    if (this.ctx) {
      try { this.ctx.close(); } catch { /* */ }
      this.ctx = null;
    }
    this.master = this.sfxGain = this.musicGain = this.musicLowGain = null;
    this.noiseBuf = null;
  }
}

export { AudioBus };