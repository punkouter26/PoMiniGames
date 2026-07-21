// audio.js — synthesized audio bus for PoBrawl.
// No audio files; everything is generated from OscillatorNode + filtered noise.
// Architecture:
//   master gain -> glue compressor -> limiter -> destination
//     ├── sfxGain       (impacts, blocks, KO, voice grunts, footsteps)
//     │     ├── panner (per source; StereoPanner keyed off world-x)
//     │     └── reverbSend -> convolver -> reverbGain -> master
//     ├── musicGain     (round-start loop stem + low-HP tension)
//     └── introGain     (round-start chiptune riff)
//
// Every public method is a no-op while muted so the game can call them freely.

// 2 seconds of noise. Longer than any single sound that reads from it, so
// every playback can start at a random offset (see `_noiseSource`) and no two
// cracks are the same waveform.
const NOISE_SECONDS = 2;

// Half-width of the arena in world units, for mapping world-x -> stereo pan.
const ARENA_HALF_WIDTH = 6;

// Music scheduler: wake every LOOKAHEAD_MS and schedule every note that falls
// due within SCHEDULE_AHEAD seconds. Timer jitter no longer reaches the audio
// clock — the timer only decides *when we schedule*, never *when a note plays*.
const LOOKAHEAD_MS = 25;
// How far ahead of the audio clock notes are queued. This is the budget for
// main-thread stalls: the timer can't fire while the thread is blocked, so any
// block longer than this drains the queue and the bass line audibly hiccups.
// A round opening (fresh rigs, first-frame shader compiles) can block for a
// couple hundred milliseconds, so keep the queue deep enough to ride that out
// — 0.1 s was not, which is why the music stuttered as a match started.
const SCHEDULE_AHEAD = 0.45;

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function makeNoiseBuffer(ctx) {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
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

// Synthesized impulse response: exponentially-decaying stereo noise. Gives the
// arena a sense of enclosure — dry hits read as happening in a vacuum.
// Decorrelated channels so the tail widens rather than sitting centre.
function makeImpulseResponse(ctx, duration = 1.2, decay = 2.6) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return ir;
}

// Release every node in `nodes` once `source` finishes. Without this each
// impact leaves its panner wired to sfxGain forever, and a long flurry piles
// up hundreds of live nodes on the audio thread.
function autoDisconnect(source, nodes) {
  source.onended = () => {
    for (const n of nodes) {
      try { n.disconnect(); } catch { /* already gone */ }
    }
  };
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
    this.reverbGain = null; // wet level for the convolver send
    this.noiseBuf = null;
    this.musicNodes = null;
    this.introGain = null;  // dedicated bus for round-start chiptune intros
    this.introNodes = null; // active intro oscillators/gains, for cleanup
    this._introRestoreVol = 0.35; // remembered musicGain value to restore after ducking
    this.lowMusicCrossfade = 0; // 0 = normal stem, 1 = low-HP stem
    this._ensureFailed = false; // latched so a broken graph can't report success
    // Audio-reactive envelope. Each SFX call nudges this up; the render loop
    // calls tick(dt) once a frame to decay it. The BrawlGame reads
    // getEnvelope() to pulse the UnrealBloomPass on every impact.
    // Both start at 0: a non-zero _envPeak is a ceiling `tick` would chase with
    // no sound playing, which pins the bloom on permanently.
    this._env = 0;
    this._envPeak = 0; // ceiling for the latest hit; decays in tick()
  }

  _ensure() {
    if (this.ctx && !this._ensureFailed) return true;
    if (this._ensureFailed) return false;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) { this._ensureFailed = true; return false; }
      const ctx = new Ctor();
      this.ctx = ctx;

      this.master = ctx.createGain();
      this.master.gain.value = 0.85;

      // Glue compressor, then a brickwall limiter. The compressor alone lets
      // simultaneous impacts punch through into clipping; the limiter is the
      // thing that actually guarantees we stay under 0 dBFS.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.18;

      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.05;

      this.master.connect(comp).connect(limiter).connect(ctx.destination);

      this.sfxGain = ctx.createGain();
      this.sfxGain.gain.value = 1.0;
      this.sfxGain.connect(this.master);

      // Reverb send: sfx go out dry via sfxGain->master and wet via this
      // parallel convolver path, so the wet level is tunable on its own.
      const convolver = ctx.createConvolver();
      convolver.buffer = makeImpulseResponse(ctx);
      this.reverbGain = ctx.createGain();
      this.reverbGain.gain.value = 0.18;
      this.sfxGain.connect(convolver).connect(this.reverbGain).connect(this.master);

      this.musicGain = ctx.createGain();
      this.musicGain.gain.value = 0.35;
      this.musicGain.connect(this.master);

      // Round-start chiptune bus — independent of sfxGain (impacts) and
      // musicGain (looped stem) so ducking only affects the loop while the
      // intro plays over the top.
      this.introGain = ctx.createGain();
      this.introGain.gain.value = 0.15;
      this.introGain.connect(this.master);

      this.noiseBuf = makeNoiseBuffer(ctx);
      return true;
    } catch (e) {
      // Latch the failure. Previously this swallowed the error and returned
      // false while leaving this.ctx assigned, so the *next* call short-circuited
      // on `if (this.ctx) return true` and reported success with a half-built
      // graph — a one-character typo silently killed every noise layer and the
      // intro themes for good. Fail closed and say so.
      this._ensureFailed = true;
      try { console.error('[pobrawl/audio] AudioContext setup failed; audio disabled.', e); } catch { /* noop */ }
      return false;
    }
  }

  // One-shot noise source, started at a random offset so repeated sounds never
  // replay the identical slice of the shared buffer.
  _noiseSource(playSeconds) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const maxOffset = Math.max(0, this.noiseBuf.duration - playSeconds - 0.01);
    src._offset = Math.random() * maxOffset;
    return src;
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
    // The ceiling has to decay too. _pulse only ever raises _envPeak (Math.max),
    // so a static ceiling is one _env chases upward and never leaves — the bloom
    // sat pinned at 1.0 through total silence.
    this._envPeak *= Math.exp(-dt * 4.0);
    const decay = Math.exp(-dt * 7.5);
    this._env = this._envPeak * (1 - decay) + this._env * decay;
    // After enough decay, both targets converge; collapse them so a new pulse
    // doesn't get averaged into the tail of a previous one.
    if (this._env < 0.005 && this._envPeak < 0.005) { this._env = 0; this._envPeak = 0; }
  }

  getEnvelope() { return this._env; }

  // Resume the context after a user gesture — Blazor can't always start audio
  // because the .razor lifecycle may not be triggered by a button click.
  async resume() {
    if (this._ensure() && this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* noop */ }
    }
  }

  // One-shot spatializer: StereoPanner keyed off world-x.
  //
  // This used to build an HRTF PannerNode. HRTF runs a convolution per node and
  // positions sound relative to ctx.listener — which nothing in the game ever
  // moves, so every hit was panned against a default listener at the origin
  // regardless of the camera. For a 2.5D fighter on a fixed side-on camera,
  // world-x -> pan is both what we actually want and far cheaper.
  _spatializer(worldPos) {
    const ctx = this.ctx;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      // 0.8 rather than a hard 1.0: fully-panned mono sounds collapse into one
      // ear on headphones and read as broken rather than positional.
      p.pan.value = worldPos ? clamp(worldPos.x / ARENA_HALF_WIDTH, -1, 1) * 0.8 : 0;
      return p;
    }
    // Fallback (no StereoPannerNode): equal-power pan across a 2-channel merger.
    const splitL = ctx.createGain();
    const splitR = ctx.createGain();
    const merger = ctx.createChannelMerger(2);
    const x = worldPos ? clamp(worldPos.x / ARENA_HALF_WIDTH, -1, 1) * 0.8 : 0;
    const angle = (x + 1) * Math.PI / 4; // 0..PI/2
    splitL.gain.value = Math.cos(angle);
    splitR.gain.value = Math.sin(angle);
    const input = ctx.createGain();
    input.connect(splitL).connect(merger, 0, 0);
    input.connect(splitR).connect(merger, 0, 1);
    // Callers connect to the returned node and read `.output` for the tail.
    input.output = merger;
    return input;
  }

  // Connect a spatializer's audible output to the sfx bus. The fallback path
  // pans through a merger, so its output node is not the node callers feed.
  _connectSpat(spat) {
    (spat.output || spat).connect(this.sfxGain);
    return spat;
  }

  // Layered impact: low thud (sine + sub noise) + mid crack (filtered noise) + hiss.
  //
  // `kind` ('punch' | 'kick') sets the weight: a kick lands lower, decays longer
  // and carries more low-mid body. Every layer is randomized per call — identical
  // repeats are the single biggest tell that a hit is synthesized.
  impact({ power = 1, blocked = false, worldPos = null, kind = 'punch' } = {}) {
    if (!this._ensure() || this.muted) return;
    this._pulse(blocked ? 0.45 : Math.min(1, 0.55 + power * 0.25));
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._connectSpat(this._spatializer(worldPos));
    const heavy = kind === 'kick';

    // 1. Body thud (sine, fast decay). Kicks sit ~30 Hz lower and ring longer.
    const thudBase = blocked ? 180 : (heavy ? 65 : 95) + power * 35;
    const thudDecay = heavy ? 0.26 : 0.18;
    const thud = ctx.createOscillator();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(thudBase * rand(0.88, 1.12), now);
    thud.frequency.exponentialRampToValueAtTime(heavy ? 38 : 45, now + (heavy ? 0.11 : 0.08));
    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.0001, now);
    thudGain.gain.linearRampToValueAtTime(
      blocked ? 0.18 : (heavy ? 0.40 : 0.34), now + rand(0.003, 0.007));
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + thudDecay);
    thud.connect(thudGain).connect(spat);
    thud.start(now); thud.stop(now + thudDecay + 0.04);
    autoDisconnect(thud, [thud, thudGain]);

    // 1b. Low-mid body — kicks only. Gives the weight a punch doesn't have.
    if (heavy && !blocked) {
      const body = ctx.createOscillator();
      body.type = 'triangle';
      body.frequency.setValueAtTime(rand(150, 190), now);
      body.frequency.exponentialRampToValueAtTime(80, now + 0.14);
      const bodyGain = ctx.createGain();
      bodyGain.gain.setValueAtTime(0.0001, now);
      bodyGain.gain.linearRampToValueAtTime(0.14, now + 0.006);
      bodyGain.gain.exponentialRampToValueAtTime(0.001, now + 0.20);
      body.connect(bodyGain).connect(spat);
      body.start(now); body.stop(now + 0.24);
      autoDisconnect(body, [body, bodyGain]);
    }

    // 2. Crack (bandpass noise burst).
    if (!blocked) {
      const crackDur = 0.08;
      const src = this._noiseSource(crackDur);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = ((heavy ? 1300 : 1800) + power * 600) * rand(0.8, 1.2);
      bp.Q.value = rand(1.1, 1.8);
      const crackGain = ctx.createGain();
      crackGain.gain.setValueAtTime(0.0001, now);
      crackGain.gain.linearRampToValueAtTime(0.22 + power * 0.05, now + rand(0.003, 0.006));
      crackGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      src.connect(bp).connect(crackGain).connect(spat);
      src.start(now, src._offset); src.stop(now + crackDur);
      autoDisconnect(src, [src, bp, crackGain]);
    }

    // 3. Hiss tail (highpass noise).
    const tailDur = 0.28;
    const tail = this._noiseSource(tailDur);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = rand(3400, 4600);
    const tailGain = ctx.createGain();
    tailGain.gain.setValueAtTime(0.0001, now);
    tailGain.gain.linearRampToValueAtTime(blocked ? 0.04 : 0.10, now + 0.01);
    tailGain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    tail.connect(hp).connect(tailGain).connect(spat);
    tail.start(now, tail._offset); tail.stop(now + tailDur);
    // Last layer to finish, so it owns tearing down the shared spatializer.
    autoDisconnect(tail, [tail, hp, tailGain, spat, spat.output].filter(Boolean));
  }

  block(worldPos = null) {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.4);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._connectSpat(this._spatializer(worldPos));

    // Wooden "tap" — two short triangle hits, detuned and re-spaced per block.
    const spacing = rand(0.04, 0.06);
    const detune = rand(0.9, 1.1);
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = (240 - i * 40) * detune;
      const g = ctx.createGain();
      const t0 = now + i * spacing;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.15, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.07);
      o.connect(g).connect(spat);
      o.start(t0); o.stop(t0 + 0.09);
      // Second (last) tap tears down the shared spatializer.
      autoDisconnect(o, i === 1 ? [o, g, spat, spat.output].filter(Boolean) : [o, g]);
    }
  }

  ko() {
    // _ensure/mute check first: this used to pulse the bloom envelope even when
    // audio was muted or unavailable, flashing the screen for a sound nobody heard.
    if (!this._ensure() || this.muted) return;
    this._pulse(1.0);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // Sub-bass thud + slow down sweep + crash noise.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(140, now);
    sub.frequency.exponentialRampToValueAtTime(28, now + 0.9);
    const subG = ctx.createGain();
    subG.gain.setValueAtTime(0.0001, now);
    subG.gain.linearRampToValueAtTime(0.6, now + 0.02);
    subG.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
    sub.connect(subG).connect(this.sfxGain);
    sub.start(now); sub.stop(now + 1.25);
    autoDisconnect(sub, [sub, subG]);

    const crashDur = 1.05;
    const crash = this._noiseSource(crashDur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    const cG = ctx.createGain();
    cG.gain.setValueAtTime(0.0001, now);
    cG.gain.linearRampToValueAtTime(0.35, now + 0.04);
    cG.gain.exponentialRampToValueAtTime(0.001, now + 1.0);
    crash.connect(lp).connect(cG).connect(this.sfxGain);
    crash.start(now, crash._offset); crash.stop(now + crashDur);
    autoDisconnect(crash, [crash, lp, cG]);
  }

  // Short vocal grunt on swing / windup. Random pitch so it doesn't loop.
  // Short vocal grunt on swing / windup. Random pitch so it doesn't loop.
  grunt({ power = 1, blocked = false } = {}) {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.15 + power * 0.1);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // Wider per-call spread than the old fixed pitch: a grunt repeats far more
    // often than an impact, so it goes "robotic" fastest without variation.
    const baseHz = (blocked ? 150 : 110 + power * 30) * rand(0.82, 1.22);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(baseHz, now);
    o.frequency.exponentialRampToValueAtTime(baseHz * rand(0.5, 0.62), now + rand(0.14, 0.22));
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = baseHz * rand(1.7, 2.4);
    bp.Q.value = rand(4, 6.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.08, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    o.connect(bp).connect(g).connect(this.sfxGain);
    o.start(now); o.stop(now + 0.25);
    autoDisconnect(o, [o, bp, g]);
  }

  whoosh() {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.22);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.25;
    const src = this._noiseSource(dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    const sweepFrom = rand(650, 950);
    bp.frequency.setValueAtTime(sweepFrom, now);
    bp.frequency.linearRampToValueAtTime(sweepFrom * rand(2.4, 3.0), now + rand(0.14, 0.22));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(rand(0.05, 0.075), now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    src.connect(bp).connect(g).connect(this.sfxGain);
    src.start(now, src._offset); src.stop(now + dur);
    autoDisconnect(src, [src, bp, g]);
  }

  // Cheap footstep tick — call on every other walk-cycle hit.
  footstep(volume = 0.05, worldPos = null) {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.08);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._connectSpat(this._spatializer(worldPos));
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = rand(80, 100);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(volume * rand(0.85, 1.15), now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    o.connect(g).connect(spat);
    o.start(now); o.stop(now + 0.09);
    autoDisconnect(o, [o, g, spat, spat.output].filter(Boolean));
  }

  // Continuous music stem: two layered loops we crossfade between based on HP.
  // No samples, so we synthesize a simple 4-step bass + filtered noise pad.
  startMusic() {
    if (!this._ensure() || this.musicNodes) return;
    const ctx = this.ctx;
    const tempo = 96; // bpm
    const beat = 60 / tempo;

    // Bass voice. Signal path is deliberately two gains deep:
    //   bassEnv   — the per-note envelope, written by the scheduler ahead of time
    //   bassLevel — the tension mix, written by setMusicTension
    // One shared gain can't do both: tension has to cancelScheduledValues, which
    // would wipe the notes the scheduler has already queued up.
    const bassNotes = [55, 55, 73, 65]; // A1, A1, D2, C2 (A minor pentatonic)
    const bassNode = ctx.createOscillator();
    bassNode.type = 'triangle';
    const bassEnv = ctx.createGain();
    bassEnv.gain.value = 0;
    const bassLevel = ctx.createGain();
    bassLevel.gain.value = 0.22;
    const bassLP = ctx.createBiquadFilter();
    bassLP.type = 'lowpass';
    bassLP.frequency.value = 700;
    bassNode.connect(bassLP).connect(bassEnv).connect(bassLevel).connect(this.musicGain);
    bassNode.start();

    // Lookahead scheduler. The old version fired setInterval every beat and
    // scheduled at `ctx.currentTime` — so every note landed wherever timer jitter
    // happened to put it, and a backgrounded tab (throttled to ~1s timers) stalled
    // the sequence outright. Now the timer only decides when to *queue*; note times
    // come off the audio clock and stay exact regardless of jitter.
    let step = 0;
    let nextNoteTime = ctx.currentTime + 0.05;
    const scheduleNote = (t) => {
      const freq = bassNotes[step % bassNotes.length];
      bassNode.frequency.setValueAtTime(freq, t);
      bassEnv.gain.setValueAtTime(0.0001, t);
      bassEnv.gain.linearRampToValueAtTime(1, t + 0.01);
      bassEnv.gain.exponentialRampToValueAtTime(0.0001, t + beat * 0.85);
      step++;
    };
    const scheduler = () => {
      if (this.musicNodes?.stopped) return;
      // Catch-up guard. If the main thread was blocked past the lookahead
      // window (or the tab was throttled), nextNoteTime is now in the past.
      // Scheduling those notes anyway makes the AudioParam ramps fire
      // immediately, cramming a whole run of beats into one instant — the
      // stutter is the catch-up, not the gap. Skip the missed beats and
      // resume on the next one still in the future, staying on the grid.
      if (nextNoteTime < ctx.currentTime) {
        const missed = Math.ceil((ctx.currentTime - nextNoteTime) / beat);
        nextNoteTime += missed * beat;
        step += missed;
      }
      while (nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
        scheduleNote(nextNoteTime);
        nextNoteTime += beat;
      }
    };
    const bassInterval = setInterval(scheduler, LOOKAHEAD_MS);
    scheduler();

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
      bassNode, bassEnv, bassLevel, bassInterval, pad, lfo, padGain,
      stopped: false,
    };
  }

  // 0..1 — how much to crossfade the music toward the "low-HP" stem.
  // We simulate the low-HP stem by attenuating the bass + brightening the pad.
  setMusicTension(t) {
    this.lowMusicCrossfade = clamp(t, 0, 1);
    if (!this.musicNodes || !this._ensure()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // Writes bassLevel, not the per-note envelope — see startMusic.
    this.musicNodes.bassLevel.gain.cancelScheduledValues(now);
    this.musicNodes.bassLevel.gain.linearRampToValueAtTime(0.22 - 0.16 * this.lowMusicCrossfade, now + 0.4);
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
    this.master = this.sfxGain = this.musicGain = this.reverbGain = this.introGain = null;
    this.noiseBuf = null;
  }
}

export { AudioBus };