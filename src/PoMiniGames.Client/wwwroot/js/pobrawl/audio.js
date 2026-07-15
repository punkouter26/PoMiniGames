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

// Note name → MIDI semitone offset (C4 = 60 → freq 261.63 Hz).
// Supports sharps (#) and flats (b); octave is parsed from the digits.
const NOTE_NAMES = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4,
                     F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8,
                     A: 9, 'A#': 10, Bb: 10, B: 11 };
function noteToFreq(name) {
  const m = /^([A-G][#b]?)(-?\d+)$/.exec(name);
  if (!m) return 440;
  const semi = NOTE_NAMES[m[1]];
  const oct = parseInt(m[2], 10);
  const midi = (oct + 1) * 12 + semi;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// Round-start chiptune intros. Each entry is a ≤5-second two-voice riff
// inspired by a popular tune from the president's era:
//   melody  — the lead line (square wave, lightly detuned pair)
//   bass    — the root/fifth foundation (triangle wave)
// The key MUST match the charId in fighters.js — used as INTRO_THEMES[id].
const INTRO_THEMES = {
  // Donald Trump (2017-2021) — riff from "Eye of the Tiger" (Survivor, 1982)
  trump: {
    bpm: 138,
    melody: [
      ['E4', 0.5], ['E4', 0.5], ['G#4', 0.5], ['E4', 0.5],
      ['B3', 0.5], ['C5', 0.5], ['D5', 0.5], ['E5', 0.5],
      ['E4', 0.5], ['E4', 0.5], ['G#4', 0.5], ['E4', 0.5],
      ['B3', 0.5], ['C5', 0.5], ['D5', 1], ['E5', 1],
    ],
    bass: [['E2', 2], ['A2', 2], ['E2', 2], ['B2', 2]],
  },
  // Joe Biden (2021-2025) — riff from "Don't Stop Believin'" (Journey, 1981)
  biden: {
    bpm: 119,
    melody: [
      ['E4', 1], ['E4', 1], ['G4', 1], ['E4', 1],
      ['G4', 0.5], ['A4', 0.5], ['B4', 0.5], ['A4', 0.5],
      ['G4', 0.5], ['F#4', 0.5], ['E4', 1], ['D4', 1],
    ],
    bass: [['E2', 2], ['A2', 2], ['D3', 2], ['A2', 2]],
  },
  // Barack Obama (2009-2017) — riff from "Signed, Sealed, Delivered" (Stevie Wonder, 1970)
  obama: {
    bpm: 110,
    melody: [
      ['F4', 0.5], ['F4', 0.5], ['Eb4', 0.5], ['F4', 0.5],
      ['F4', 0.5], ['F4', 0.5], ['Eb4', 0.5], ['F4', 0.5],
      ['F4', 0.5], ['Eb4', 0.5], ['F4', 1], ['G4', 1],
    ],
    bass: [['F2', 2], ['Bb2', 2], ['F2', 2], ['C3', 2]],
  },
  // George W. Bush (2001-2009) — riff from "Sweet Home Alabama" (Lynyrd Skynyrd, 1974)
  bush: {
    bpm: 96,
    melody: [
      ['D5', 0.5], ['D5', 0.5], ['C5', 0.5], ['G4', 0.5],
      ['D5', 0.5], ['D5', 0.5], ['C5', 0.5], ['G4', 0.5],
      ['D5', 0.5], ['C5', 0.5], ['G4', 1], ['D5', 1],
    ],
    bass: [['D2', 2], ['G2', 2], ['D2', 2], ['A2', 2]],
  },
  // Bill Clinton (1993-2001) — riff from "Don't Stop" (Fleetwood Mac, 1977)
  clinton: {
    bpm: 120,
    melody: [
      ['G4', 1], ['D5', 1], ['E5', 1], ['D5', 0.5],
      ['C5', 0.5], ['D5', 1], ['E5', 0.5], ['D5', 0.5],
      ['E5', 0.5], ['D5', 0.5], ['C5', 1], ['B4', 1],
    ],
    bass: [['G2', 2], ['D3', 2], ['E2', 2], ['C3', 2]],
  },
  // George H.W. Bush (1989-1993) — riff from "I've Been Everywhere" (Johnny Cash, 1962)
  bushsr: {
    bpm: 130,
    melody: [
      ['A4', 0.5], ['A4', 0.5], ['A4', 0.5], ['A4', 0.5],
      ['G4', 0.5], ['A4', 0.5], ['A4', 0.5], ['A4', 0.5],
      ['B4', 0.5], ['C5', 0.5], ['D5', 1], ['E5', 1],
    ],
    bass: [['A2', 2], ['E2', 2], ['D2', 2], ['A2', 2]],
  },
  // Ronald Reagan (1981-1989) — riff from "God Bless the U.S.A." (Lee Greenwood, 1984)
  reagan: {
    bpm: 110,
    melody: [
      ['C5', 0.5], ['G4', 0.5], ['A4', 0.5], ['F4', 0.5],
      ['C5', 0.5], ['G4', 0.5], ['F4', 0.5], ['G4', 0.5],
      ['C5', 0.5], ['G4', 0.5], ['A4', 0.5], ['F4', 0.5],
      ['C5', 1], ['G4', 1],
    ],
    bass: [['C2', 2], ['G2', 2], ['A1', 2], ['F2', 2]],
  },
  // Jimmy Carter (1977-1981) — riff from "Georgia on My Mind" (Ray Charles, 1960)
  carter: {
    bpm: 80,
    melody: [
      ['F4', 1], ['E4', 0.5], ['F4', 0.5], ['A4', 1],
      ['G4', 0.5], ['F4', 0.5], ['E4', 1], ['D4', 1],
    ],
    bass: [['F2', 2], ['C2', 2], ['D2', 2], ['Bb1', 2]],
  },
  // Gerald Ford (1974-1977) — riff from "Rock the Boat" (The Hues Corporation, 1974)
  ford: {
    bpm: 124,
    melody: [
      ['A4', 0.5], ['G4', 0.5], ['F4', 0.5], ['E4', 0.5],
      ['D4', 0.5], ['E4', 0.5], ['F4', 0.5], ['G4', 0.5],
      ['A4', 0.5], ['B4', 0.5], ['C5', 0.5], ['D5', 0.5],
      ['C5', 1],
    ],
    bass: [['A1', 2], ['G1', 2], ['F1', 2], ['E1', 2]],
  },
  // Richard Nixon (1969-1974) — riff from "(Sittin' On) The Dock of the Bay" (Otis Redding, 1968)
  nixon: {
    bpm: 104,
    melody: [
      ['G4', 0.5], ['B4', 0.5], ['D5', 0.5], ['B4', 0.5],
      ['G4', 1], ['E4', 1],
      ['G4', 0.5], ['B4', 0.5], ['D5', 0.5], ['B4', 0.5],
      ['A4', 0.5], ['G4', 1],
    ],
    bass: [['G2', 2], ['E2', 2], ['A1', 2], ['G2', 2]],
  },
  // Lyndon B. Johnson (1963-1969) — riff from "Ballad of the Green Berets" (Barry Sadler, 1966)
  lbj: {
    bpm: 88,
    melody: [
      ['C4', 0.5], ['C4', 0.5], ['E4', 0.5], ['G4', 0.5],
      ['G4', 0.5], ['E4', 0.5], ['C4', 0.5], ['D4', 0.5],
      ['F4', 0.5], ['F4', 0.5], ['F4', 0.5], ['E4', 0.5],
      ['D4', 1], ['C4', 1],
    ],
    bass: [['C2', 2], ['G2', 2], ['F2', 2], ['C2', 2]],
  },
  // John F. Kennedy (1961-1963) — riff from "High Hopes" (Frank Sinatra, 1959)
  jfk: {
    bpm: 120,
    melody: [
      ['A4', 0.5], ['A4', 0.5], ['A4', 0.5], ['A4', 0.5],
      ['G4', 0.5], ['A4', 0.5], ['C5', 0.5], ['B4', 0.5],
      ['A4', 0.5], ['G4', 0.5], ['F4', 0.5], ['G4', 0.5],
      ['A4', 1], ['E4', 1],
    ],
    bass: [['A1', 2], ['E2', 2], ['F#1', 2], ['D2', 2]],
  },
  // Dwight D. Eisenhower (1953-1961) — riff from "In the Mood" (Glen Miller, 1939)
  eisenhower: {
    bpm: 150,
    melody: [
      ['F4', 0.5], ['D5', 0.5], ['C5', 0.5], ['A4', 0.5],
      ['Bb4', 0.5], ['A4', 0.5], ['G4', 0.5], ['F4', 0.5],
      ['G4', 0.5], ['A4', 0.5], ['Bb4', 0.5], ['C5', 0.5],
      ['D5', 1], ['C5', 1],
    ],
    bass: [['Bb1', 2], ['F2', 2], ['G2', 2], ['C3', 2]],
  },
  // Harry S. Truman (1945-1953) — riff from "Sentimental Journey" (Les Brown / Doris Day, 1945)
  truman: {
    bpm: 100,
    melody: [
      ['C4', 0.5], ['E4', 0.5], ['G4', 0.5], ['C5', 0.5],
      ['B4', 0.5], ['A4', 0.5], ['G4', 0.5], ['E4', 0.5],
      ['F4', 0.5], ['G4', 0.5], ['A4', 0.5], ['B4', 0.5],
      ['C5', 1], ['G4', 1],
    ],
    bass: [['C2', 2], ['G1', 2], ['F1', 2], ['C2', 2]],
  },
  // Franklin D. Roosevelt (1933-1945) — riff from "Happy Days Are Here Again" (1929)
  fdr: {
    bpm: 100,
    melody: [
      ['G4', 0.5], ['G4', 0.5], ['G4', 0.5], ['C5', 0.5],
      ['B4', 0.5], ['A4', 0.5], ['G4', 0.5], ['F4', 0.5],
      ['E4', 0.5], ['E4', 0.5], ['A4', 0.5], ['G4', 0.5],
      ['F4', 1], ['E4', 1],
    ],
    bass: [['G2', 2], ['D2', 2], ['C2', 2], ['G1', 2]],
  },
};

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
    this.introGain = null;  // dedicated bus for round-start chiptune intros
    this.introNodes = null; // active intro oscillators/gains, for cleanup
    this._introRestoreVol = 0.35; // remembered musicGain value to restore after ducking
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
      this.musicLowGain.connect(this.master);      // Round-start chiptune bus — independent of sfxGain (impacts) and
      // musicGain (looped stem) so ducking only affects the loop while the
      // intro plays over the top.
      this.introGain = ctx.createGain();
      this.introGain.gain.value = 0.30;
      this.introGain.connect(this.master);      this.noiseBuf = makeNoiseBuffer(this.ctx);
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

  // Round-start chiptune intro. Plays a short (~4–5s) period-appropriate riff
  // for the given character on introGain while ducking the musicGain loop.
  // Safe to call repeatedly — any in-flight intro is stopped first.
  //   charId — must match a key in INTRO_THEMES (i.e. a fighters.js charId).
  playIntroTheme(charId) {
    if (!this._ensure() || this.muted) return;
    const theme = INTRO_THEMES[charId];
    if (!theme || !this.introGain) return;

    // Cancel anything still ringing from a previous intro.
    this.stopIntroTheme();

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const beatDur = 60 / theme.bpm;

    // Total length is the longer of melody / bass in beats.
    let melodyBeats = 0, bassBeats = 0;
    for (const [, d] of theme.melody) melodyBeats += d;
    if (theme.bass) for (const [, d] of theme.bass) bassBeats += d;
    const totalDur = Math.max(melodyBeats, bassBeats) * beatDur;

    // Duck musicGain down so the intro sits clearly on top, then restore it.
    // Scheduled in audio-time so it survives tab-throttling.
    if (this.musicGain) {
      this._introRestoreVol = this.musicGain.gain.value;
      this.musicGain.gain.cancelScheduledValues(now);
      this.musicGain.gain.linearRampToValueAtTime(0.08, now + 0.08);
      const restoreAt = now + totalDur + 0.15;
      this.musicGain.gain.linearRampToValueAtTime(this._introRestoreVol, restoreAt + 0.35);
    }

    const created = [];

    // Lead voice — pair of slightly-detuned square oscillators for that
    // NES-style chiptune heft. Hard 5ms attack, exponential release tail.
    let t = 0;
    for (const [note, dur] of theme.melody) {
      const startT = now + t * beatDur;
      const endT = startT + dur * beatDur * 0.92;
      const freq = noteToFreq(note);

      const o1 = ctx.createOscillator();
      o1.type = 'square';
      o1.frequency.value = freq;
      const o2 = ctx.createOscillator();
      o2.type = 'square';
      o2.frequency.value = freq * 1.006; // 0.6% detune → slight chorus
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, startT);
      g.gain.linearRampToValueAtTime(0.14, startT + 0.006);
      g.gain.setValueAtTime(0.14, endT - 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, endT);

      o1.connect(g); o2.connect(g); g.connect(this.introGain);
      o1.start(startT); o2.start(startT);
      o1.stop(endT + 0.02); o2.stop(endT + 0.02);
      created.push(o1, o2, g);
      t += dur;
    }

    // Bass voice — single triangle oscillator, slight attack/release.
    if (theme.bass) {
      let bt = 0;
      for (const [note, dur] of theme.bass) {
        const startT = now + bt * beatDur;
        const endT = startT + dur * beatDur * 0.94;
        const freq = noteToFreq(note);

        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = freq;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, startT);
        g.gain.linearRampToValueAtTime(0.11, startT + 0.008);
        g.gain.setValueAtTime(0.11, endT - 0.04);
        g.gain.exponentialRampToValueAtTime(0.0001, endT);

        o.connect(g).connect(this.introGain);
        o.start(startT); o.stop(endT + 0.02);
        created.push(o, g);
        bt += dur;
      }
    }

    this.introNodes = created;
  }

  // Stop any in-flight intro theme. Idempotent.
  stopIntroTheme() {
    if (!this.introNodes) return;
    const ctx = this.ctx;
    const now = ctx ? ctx.currentTime : 0;
    // Snap musicGain back to its pre-duck volume in case we cut mid-intro.
    if (this.musicGain && ctx) {
      this.musicGain.gain.cancelScheduledValues(now);
      this.musicGain.gain.linearRampToValueAtTime(this._introRestoreVol, now + 0.08);
    }
    for (const n of this.introNodes) {
      try { if (n.stop) n.stop(); } catch { /* already stopped */ }
      try { n.disconnect(); } catch { /* already disconnected */ }
    }
    this.introNodes = null;
  }

  close() {
    this.stopMusic();
    this.stopIntroTheme();
    if (this.ctx) {
      try { this.ctx.close(); } catch { /* */ }
      this.ctx = null;
    }
    this.master = this.sfxGain = this.musicGain = this.musicLowGain = this.introGain = null;
    this.noiseBuf = null;
  }
}

export { AudioBus };