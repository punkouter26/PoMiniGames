// audio.js — synthesized audio bus for PoBrawl.
// No audio files; everything is generated from OscillatorNode + filtered noise.
// Architecture:
//   master gain -> glue compressor -> limiter -> destination
//     ├── sfxGain       (impacts, blocks, KO, voice grunts, the charge risers)
//     │     ├── panner (per source; StereoPanner keyed off world-x, or a PannerNode
//     │     │           against the camera's AudioListener in the player modes)
//     │     ├── perspEq -> perspHc (the camera perspective: low-mid thump, high-cut)
//     │     └── sfxFilter ─┬─> master
//     │                    └─> perspSend -> convolver -> reverbGain -> master
//     ├── crowdGain -> crowdDuck -> crowdPersp   (bed; rhythmGain joins at crowdDuck)
//     ├── stingGain     (leitmotifs, fanfares, brass stabs: non-diegetic, no perspective)
//     ├── musicGain     (round-start loop stem + low-HP tension)
//     └── introGain     (round-start chiptune riff)
//
// The showtime half (audioShow.js) drives the second set of methods at the bottom of the
// class: the conductor grid, the per-president leitmotifs, the charge risers, the camera
// perspective and the crowd's stomp-clap / chant. There is no music bed (app-wide rule):
// the conductor is a silent clock that the stingers and the crowd lock onto.
//
// Every public method is a no-op while muted so the game can call them freely.

// Seconds of shared noise; longer than any sound reading it, so each playback
// starts at a random offset (`_noiseSource`).
const NOISE_SECONDS = 2;

// Half-width of the arena in world units, for mapping world-x -> stereo pan.
const ARENA_HALF_WIDTH = 6;

// Music scheduler: wake every LOOKAHEAD_MS, queue notes due within SCHEDULE_AHEAD
// seconds. SCHEDULE_AHEAD is the main-thread stall budget — a round opening can
// block a few hundred ms, and anything longer drains the queue audibly.
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.45;

// SFX-bus lowpass: open (20 kHz, not Infinity — the corner's phase response stays
// out of band) normally, swept down to MUFFLED (Hz) for the concussion.
const SFX_FILTER_OPEN = 20000;
const SFX_FILTER_MUFFLED = 420;
// Music sidechain attack/release, seconds.
const DUCK_ATTACK = 0.012;
const DUCK_RELEASE = 0.32;

// Crowd bed: three filtered-noise layers; intensity raises level and brightens the mid band.
const CROWD_BASE_GAIN = 0.05;
const CROWD_PEAK_GAIN = 0.16;

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

// Synthesized IR: exponentially decaying, decorrelated stereo noise.
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

// Release `nodes` once `source` ends, or a flurry piles up live nodes on the audio thread.
// `after` runs once the nodes are gone (voice counters).
function autoDisconnect(source, nodes, after = null) {
  source.onended = () => {
    for (const n of nodes) {
      try { n.disconnect(); } catch { /* already gone */ }
    }
    if (after) after();
  };
}

// Announcer voice, cached (getVoices() is slow). It wants an American, deep, LOCAL voice — network voices ("Natural", "Online") lag
// hundreds of ms, and a late "K.O." is worse than a robotic one.
let _announcerVoice = null;
let _announcerVoiceResolved = false;
function pickAnnouncerVoice() {
  if (_announcerVoiceResolved) return _announcerVoice;
  let voices = [];
  try { voices = window.speechSynthesis?.getVoices() || []; } catch { return null; }
  // Voice lists populate asynchronously on Chrome; an empty list means "not
  // yet", not "none", so stay unresolved and try again on the next call.
  if (!voices.length) return null;
  const local = voices.filter((v) => v.localService !== false
    && !/natural|online/i.test(v.name));
  const pool = local.length ? local : voices;
  _announcerVoice =
    pool.find((v) => v.lang?.startsWith('en-US') && /david|mark|guy|male/i.test(v.name))
    || pool.find((v) => v.lang?.startsWith('en') && /david|mark|guy|male/i.test(v.name))
    || pool.find((v) => v.lang?.startsWith('en-US'))
    || pool.find((v) => v.lang?.startsWith('en'))
    || pool[0]
    || null;
  _announcerVoiceResolved = true;
  return _announcerVoice;
}

// Per-fighter grunt voice: pitch f0 (Hz), vowel formants f1/f2 (Hz), rasp = breath
// noise through the upper formant (0..1). Unknown ids use DEFAULT_VOICE.
const VOICES = {
  trump:      { f0: 105, f1: 650, f2: 1100, rasp: 0.35 },
  biden:      { f0: 118, f1: 600, f2: 1300, rasp: 0.45 },
  obama:      { f0: 98,  f1: 560, f2: 1050, rasp: 0.15 },
  bush:       { f0: 112, f1: 700, f2: 1250, rasp: 0.25 },
  clinton:    { f0: 120, f1: 620, f2: 1350, rasp: 0.6 },
  bushsr:     { f0: 130, f1: 580, f2: 1450, rasp: 0.2 },
  reagan:     { f0: 108, f1: 540, f2: 1150, rasp: 0.5 },
  carter:     { f0: 125, f1: 660, f2: 1500, rasp: 0.15 },
  ford:       { f0: 110, f1: 600, f2: 1200, rasp: 0.2 },
  nixon:      { f0: 100, f1: 520, f2: 1000, rasp: 0.3 },
  lbj:        { f0: 95,  f1: 640, f2: 1080, rasp: 0.4 },
  jfk:        { f0: 122, f1: 700, f2: 1400, rasp: 0.2 },
  eisenhower: { f0: 115, f1: 560, f2: 1250, rasp: 0.25 },
  truman:     { f0: 128, f1: 620, f2: 1550, rasp: 0.15 },
  fdr:        { f0: 104, f1: 580, f2: 1150, rasp: 0.2 },
};
const DEFAULT_VOICE = { f0: 112, f1: 600, f2: 1250, rasp: 0.25 };

// Note name → semitone (C4 = MIDI 60); sharps (#) and flats (b).
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

// Round-start chiptune intros: ≤5 s two-voice riffs (melody = detuned squares,
// bass = triangle), [note, beats]. Keys MUST match the charId in fighters.js.
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

// ══ Showtime tables (audioShow.js) ═════════════════════════════════════

// Per-president leitmotif: 4-7 notes as semitones over `root`, durations in 16ths, and a
// timbre (TIMBRES in _tone). Original figures, written to the character, not quotations:
// the countdown trades them corner to corner, a super plays the owner's as a brass stinger,
// and the winner's resolves into a fanfare. Keys MUST match the charId in fighters.js.
const MOTIFS = {
  trump:      { root: 'F3',  timbre: 'brass', notes: [0, 0, 7, 12, 11, 12],    durs: [1, 1, 2, 2, 1, 3] },
  biden:      { root: 'D4',  timbre: 'reed',  notes: [0, 4, 7, 9, 7],          durs: [2, 1, 1, 2, 4] },
  obama:      { root: 'Eb4', timbre: 'keys',  notes: [0, 7, 5, 10, 12],        durs: [1, 1, 2, 2, 4] },
  bush:       { root: 'G3',  timbre: 'twang', notes: [0, 2, 4, 7, 4, 7],       durs: [1, 1, 1, 2, 1, 3] },
  clinton:    { root: 'C4',  timbre: 'sax',   notes: [0, 3, 5, 6, 7, 10],      durs: [1, 1, 1, 1, 2, 4] },
  bushsr:     { root: 'Bb3', timbre: 'brass', notes: [0, 5, 7, 12],            durs: [2, 2, 2, 6] },
  reagan:     { root: 'C4',  timbre: 'brass', notes: [0, 7, 9, 7, 12],         durs: [1, 1, 1, 1, 4] },
  carter:     { root: 'F4',  timbre: 'pluck', notes: [0, 2, 4, 0, 7],          durs: [1, 1, 1, 1, 4] },
  ford:       { root: 'A3',  timbre: 'organ', notes: [0, 4, 2, 5, 4],          durs: [2, 1, 1, 2, 4] },
  nixon:      { root: 'E3',  timbre: 'organ', notes: [0, 3, 6, 5, 3, 0],       durs: [1, 1, 2, 1, 1, 4] },
  lbj:        { root: 'D3',  timbre: 'twang', notes: [0, 0, 5, 7, 9, 7],       durs: [1, 1, 2, 1, 1, 3] },
  jfk:        { root: 'G4',  timbre: 'bell',  notes: [0, 4, 7, 11, 12],        durs: [1, 1, 1, 1, 4] },
  eisenhower: { root: 'F3',  timbre: 'brass', notes: [0, 5, 9, 12, 9, 12],     durs: [1, 1, 1, 2, 1, 4] },
  truman:     { root: 'C4',  timbre: 'keys',  notes: [0, 4, 7, 9, 7, 4, 12],   durs: [1, 1, 1, 1, 1, 1, 4] },
  fdr:        { root: 'Eb4', timbre: 'reed',  notes: [7, 9, 7, 4, 0],          durs: [1, 1, 1, 1, 4] },
  bob:        { root: 'C4',  timbre: 'chip',  notes: [0, 12, 7, 0],            durs: [1, 1, 1, 3] },
};
const DEFAULT_MOTIF = { root: 'C4', timbre: 'brass', notes: [0, 4, 7, 12], durs: [1, 1, 1, 3] };

// Camera perspective (setPerspective). send = reverb-send multiplier, thump = low-mid peak
// (dB at 170 Hz), hc = high-cut corner (Hz), crowd = crowd-bed multiplier.
//   tight — close/ots/two/push-in/reaction: drier, closer, chest-thump, crowd back
//   mid   — the house angle and the over-the-top jib
//   wide  — establishing: the room opens up, the hall is louder, the air dulls the top
//   ko    — the KO cinematic: big room AND the thump
const PERSPECTIVES = {
  tight: { send: 0.45, thump: 4.5,  hc: 20000, crowd: 0.62 },
  mid:   { send: 1.0,  thump: 0,    hc: 20000, crowd: 1.0 },
  wide:  { send: 1.8,  thump: -1.5, hc: 7200,  crowd: 1.3 },
  ko:    { send: 1.5,  thump: 3,    hc: 20000, crowd: 1.1 },
};
// Perspective glide, seconds (setTargetAtTime time constant): no clicks on a hard cut.
const PERSP_TAU = 0.12;

// "U-S-A!" chant syllables: duration (s) and three formants as [from, to] Hz glides across
// the vowel; `sib` closes the syllable on an /s/ hiss (crowdChant).
const CHANT_VOWELS = {
  U: { dur: 0.24, f: [[300, 330], [2100, 900], [2700, 2300]] },              // "you"
  S: { dur: 0.3,  f: [[580, 560], [1800, 1750], [2550, 2550]], sib: true },  // "ess"
  A: { dur: 0.46, f: [[680, 420], [1700, 2250], [2550, 2900]] },             // "ay"
};

// Charge risers: at most this many live at once (two corners plus a straggler in its snap).
const MAX_RISERS = 3;
// Balloon pops: a drop pops dozens at once; past this many live voices, pops are dropped.
const MAX_POPS = 8;
// A super calls superStinger twice (the show bus with the owner, personalityEffects without):
// a second call inside this window is the same super.
const SUPER_DEDUPE_SEC = 0.3;

// Lazy AudioContext + master bus, built on first call.
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
    // Audio-reactive envelope for the bloom pulse (getEnvelope); SFX nudge it, tick(dt)
    // decays it. Both must start at 0 or tick chases a ceiling and pins the bloom on.
    this._env = 0;
    this._envPeak = 0; // ceiling for the latest hit; decays in tick()
    this.sfxFilter = null;   // concussion lowpass, in-line on the SFX bus
    this.musicDuck = null;   // sidechain VCA between musicGain and master
    this.crowdGain = null;   // crowd bed level (owned by setCrowdIntensity)
    this.crowdDuck = null;   // crowd duck VCA (owned by the announcer)
    this._crowdBase = 0;     // level setCrowdIntensity last asked for
    this._crowdNodes = null; // live crowd oscillators/sources, for teardown
    this._crowdIntensity = 0;
    this._hitstopDepth = 0;  // 0 = normal, 1 = fully "in the vacuum"
    this._speaking = false;
    // Showtime (audioShow.js).
    this.stingGain = null;   // leitmotif / fanfare bus
    this.rhythmGain = null;  // crowd stomp-clap + chant level (owned by setCrowdRhythm)
    this.perspEq = this.perspHc = this.perspSend = this.crowdPersp = null;
    this._persp = 'mid';
    this._listenerMode = null; // null = StereoPanner by world-x; 'HRTF' | 'equalpower' = PannerNode
    this._grid = null;         // () => seconds to the next conductor 8th/16th (≤ ~120 ms)
    this._risers = new Set();  // live charge-riser handles
    this._popVoices = 0;
    this._superAt = -1;
  }

  _ensure() {
    if (this.ctx && !this._ensureFailed) return true;
    if (this._ensureFailed) return false;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) { this._ensureFailed = true; return false; }
      // Shared context (js/audioBus.js) — one AudioContext for the whole app.
      const shared = window.PoAudioBus && window.PoAudioBus.contextSync();
      const ctx = shared || new Ctor();
      this.ctx = ctx;
      // Only a context we made is ours to close — see close().
      this._ownsCtx = !shared;

      this.master = ctx.createGain();
      this.master.gain.value = 0.85;

      // Glue compressor, then a brickwall limiter to stay under 0 dBFS.
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

      this.master.connect(comp).connect(limiter).connect(
        (window.PoAudioBus && window.PoAudioBus.busSync('sfx')) || ctx.destination);
      // Post-limiter mix, tapped by tapStream() for the KO clip recorder (clip.js).
      this.out = limiter;

      this.sfxGain = ctx.createGain();
      this.sfxGain.gain.value = 1.0;

      // Concussion filter: dry AND wet pass through it, so the reverb muffles too.
      this.sfxFilter = ctx.createBiquadFilter();
      this.sfxFilter.type = 'lowpass';
      this.sfxFilter.frequency.value = SFX_FILTER_OPEN;
      // Non-resonant, so the sweep doesn't whistle.
      this.sfxFilter.Q.value = 0.0001;
      // Camera perspective (setPerspective owns all three): a low-mid peak for the close
      // shots' chest-thump and a high-cut for the wide shots' air, ahead of the concussion
      // filter, plus the reverb-send level below.
      this.perspEq = ctx.createBiquadFilter();
      this.perspEq.type = 'peaking';
      this.perspEq.frequency.value = 170;
      this.perspEq.Q.value = 0.9;
      this.perspEq.gain.value = 0;
      this.perspHc = ctx.createBiquadFilter();
      this.perspHc.type = 'lowpass';
      this.perspHc.frequency.value = SFX_FILTER_OPEN;
      this.perspHc.Q.value = 0.0001;
      this.sfxGain.connect(this.perspEq).connect(this.perspHc).connect(this.sfxFilter);
      this.sfxFilter.connect(this.master);

      // Parallel reverb send, so the wet level is tunable on its own. Two stages, two
      // owners: perspSend (setPerspective) and reverbGain (setHitstop).
      const convolver = ctx.createConvolver();
      convolver.buffer = makeImpulseResponse(ctx);
      this._convolver = convolver;
      this.perspSend = ctx.createGain();
      this.perspSend.gain.value = 1;
      this.reverbGain = ctx.createGain();
      this.reverbGain.gain.value = 0.18;
      this.sfxFilter.connect(this.perspSend).connect(convolver).connect(this.reverbGain).connect(this.master);

      this.musicGain = ctx.createGain();
      this.musicGain.gain.value = 0.35;
      // Sidechain VCA: a separate gain because setMusicTension/playIntroTheme own (and
      // cancelScheduledValues on) musicGain. One owner per automation stage.
      this.musicDuck = ctx.createGain();
      this.musicDuck.gain.value = 1.0;
      // Danger lowpass, owned by setDanger(); wide open unless a fighter nears KO.
      this.musicLP = ctx.createBiquadFilter();
      this.musicLP.type = 'lowpass';
      this.musicLP.frequency.value = SFX_FILTER_OPEN;
      this.musicLP.Q.value = 0.0001;
      this.musicGain.connect(this.musicLP).connect(this.musicDuck).connect(this.master);

      // Crowd bed bus, outside sfx/music. Two stages, two owners: crowdGain
      // (setCrowdIntensity) and crowdDuck (the announcer).
      this.crowdGain = ctx.createGain();
      this.crowdGain.gain.value = 0;
      this.crowdDuck = ctx.createGain();
      this.crowdDuck.gain.value = 1.0;
      // Third stage, third owner: the camera perspective (setPerspective).
      this.crowdPersp = ctx.createGain();
      this.crowdPersp.gain.value = 1.0;
      this.crowdGain.connect(this.crowdDuck).connect(this.crowdPersp).connect(this.master);
      // The crowd's rhythm section (stomp-clap, chant): joins after crowdGain so the bed's
      // intensity level doesn't scale it twice, but before the PA duck and the perspective.
      // A little of it goes to the room, or a hall of stomping reads as one drum.
      this.rhythmGain = ctx.createGain();
      this.rhythmGain.gain.value = 0;
      this.rhythmGain.connect(this.crowdDuck);
      const rhythmSend = ctx.createGain();
      rhythmSend.gain.value = 0.7;
      this.rhythmGain.connect(rhythmSend).connect(convolver);

      // Stinger bus: the leitmotifs and fanfares are the broadcast's, not the room's, so
      // they skip the perspective and the concussion and take only a touch of reverb.
      this.stingGain = ctx.createGain();
      this.stingGain.gain.value = 0.6;
      this.stingGain.connect(this.master);
      const stingSend = ctx.createGain();
      stingSend.gain.value = 0.35;
      this.stingGain.connect(stingSend).connect(convolver);

      // Round-start chiptune bus, separate so ducking the loop leaves the intro alone.
      this.introGain = ctx.createGain();
      this.introGain.gain.value = 0.15;
      this.introGain.connect(this.master);

      this.noiseBuf = makeNoiseBuffer(ctx);
      return true;
    } catch (e) {
      // Latch the failure so a half-built graph never reports success.
      this._ensureFailed = true;
      try { console.error('[pobrawl/audio] AudioContext setup failed; audio disabled.', e); } catch { /* noop */ }
      return false;
    }
  }

  // One-shot noise source at a random offset into the shared buffer.
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
    // The crowd bed loops, so tear it down on mute rather than leave it running.
    if (this.muted) this.stopCrowd();
    else if (this.ctx) this.startCrowd();
    // A held charge riser would otherwise drone on under the mute until its release.
    if (this.muted) this.stopRisers();
    // Speech bypasses master.gain, so mute has to stop it separately.
    if (this.muted) this.stopAnnounce();
  }

  // Big hits ~1.0, blocks ~0.4, whooshes ~0.2.
  _pulse(power) {
    this._envPeak = Math.max(this._envPeak, Math.min(1, power));
  }

  // Per-frame decay (~90 ms halflife; silence → 0 in ~0.5 s). The ceiling decays
  // too, since _pulse only raises it.
  tick(dt) {
    this._envPeak *= Math.exp(-dt * 4.0);
    const decay = Math.exp(-dt * 7.5);
    this._env = this._envPeak * (1 - decay) + this._env * decay;
    if (this._env < 0.005 && this._envPeak < 0.005) { this._env = 0; this._envPeak = 0; }
  }

  getEnvelope() { return this._env; }

  // Resume the context after a user gesture.
  async resume() {
    if (this._ensure() && this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* noop */ }
    }
  }

  // One-shot spatializer: StereoPanner keyed off world-x (cheap; fits the side-on camera).
  // In the player modes (setListenerMode) a PannerNode instead, placed at the world position
  // and heard from the camera's AudioListener — the one camera the player is looking through.
  // The director modes keep world-x: a TV mix doesn't flip sides on every reverse angle.
  _spatializer(worldPos) {
    const ctx = this.ctx;
    if (this._listenerMode && worldPos && ctx.createPanner) {
      const p = ctx.createPanner();
      p.panningModel = this._listenerMode;
      // Inverse law, flat inside 9 m (the boom's working distance), so the camera mix
      // keeps the stereo path's level: position, not loudness, is what changes.
      p.distanceModel = 'inverse';
      p.refDistance = 9;
      p.rolloffFactor = 0.3;
      p.maxDistance = 60;
      this._placePanner(p, worldPos);
      return p;
    }
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      // Max 0.8: hard-panned mono reads as broken on headphones.
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

  // The fallback spatializer's output (merger) is not the node callers feed.
  _connectSpat(spat) {
    (spat.output || spat).connect(this.sfxGain);
    return spat;
  }

  _placePanner(p, pos) {
    const y = pos.y ?? 1.2, z = pos.z ?? 0;
    if (p.positionX) {
      p.positionX.value = pos.x; p.positionY.value = y; p.positionZ.value = z;
    } else {
      p.setPosition(pos.x, y, z);
    }
  }

  // Re-aim a live spatializer (the charge riser follows its fighter). Glides, never steps.
  _moveSpat(spat, pos) {
    if (!pos) return;
    if (spat.panningModel !== undefined) { this._placePanner(spat, pos); return; }
    if (spat.pan) {
      this._glide(spat.pan, clamp(pos.x / ARENA_HALF_WIDTH, -1, 1) * 0.8, 0.05);
    }
  }

  // Layered impact: thud + crack + hiss. A kick lands lower and longer. Every layer
  // is randomized per call — identical repeats are the biggest synth tell.
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

  // Pain grunt when a hit lands. `charId` picks the president's voice (VOICES).
  grunt({ power = 1, blocked = false, charId = null } = {}) {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.15 + power * 0.1);
    const v = VOICES[charId] || DEFAULT_VOICE;
    // Wide per-call spread: grunts repeat most, so they go robotic fastest.
    const f0 = v.f0 * (blocked ? 1.35 : 0.95 + power * 0.25) * rand(0.9, 1.12);
    this._voice(v, f0, f0 * rand(0.5, 0.62), rand(0.18, 0.24), 0.08, 1);
  }

  // Effort "hup" on a kick or a charged swing: shorter, higher, a more open vowel.
  effort(charId, power = 1) {
    if (!this._ensure() || this.muted) return;
    const v = VOICES[charId] || DEFAULT_VOICE;
    const f0 = v.f0 * (1.15 + 0.2 * power) * rand(0.94, 1.06);
    this._voice(v, f0, f0 * 0.8, 0.13, 0.05 + 0.02 * power, 1.25);
  }

  // One exhausted exhale — game.js breathes the fighter in the red between heartbeats.
  breath(charId, strength = 1) {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const v = VOICES[charId] || DEFAULT_VOICE;
    const src = this._noiseSource(0.7);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = v.f2 * rand(0.95, 1.1);
    bp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.035 * clamp(strength, 0, 1), now + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0008, now + 0.6);
    src.connect(bp).connect(g).connect(this.sfxGain);
    src.start(now, src._offset); src.stop(now + 0.65);
    autoDisconnect(src, [src, bp, g]);
  }

  // Shared vocal tract: a sawtooth glottis sliding fromHz → toHz, through two
  // formant bandpasses in parallel, plus breath noise through the upper formant.
  // `open` scales F1 (a wider mouth raises it — "ha" versus "uh").
  _voice(v, fromHz, toHz, dur, peak, open) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(fromHz, now);
    o.frequency.exponentialRampToValueAtTime(toHz, now + dur * 0.85);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.linearRampToValueAtTime(peak, now + 0.012);
    out.gain.exponentialRampToValueAtTime(0.001, now + dur);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = v.f1 * open * rand(0.94, 1.06);
    f1.Q.value = 5;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = v.f2 * rand(0.94, 1.06);
    f2.Q.value = 7;
    const f2g = ctx.createGain();
    f2g.gain.value = 0.6;
    o.connect(f1).connect(out);
    o.connect(f2).connect(f2g).connect(out);
    const nodes = [o, f1, f2, f2g, out];
    if (v.rasp > 0.05) {
      const n = this._noiseSource(dur + 0.05);
      const ng = ctx.createGain();
      ng.gain.value = v.rasp * 0.9;
      n.connect(ng).connect(f2);
      n.start(now, n._offset); n.stop(now + dur + 0.02);
      autoDisconnect(n, [n, ng]);
    }
    out.connect(this.sfxGain);
    o.start(now); o.stop(now + dur + 0.03);
    autoDisconnect(o, nodes);
  }

  // Prop materials:
  //   wood  — a knock plus a three-mode crack (a plank's resonances ring for
  //           ~0.1 s, not a note), then a patter of splinters landing
  //   rope  — a low twang with a vibrato wobble: a cable under tension, not a string
  //   steel — inharmonic bar partials (1 : 2.76 : 5.4 : 8.93), a turnbuckle clang
  prop({ material = 'wood', power = 1, worldPos = null } = {}) {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const p = clamp(power, 0.2, 2.6);
    const spat = this._connectSpat(this._spatializer(worldPos));
    const nodes = [];
    let end = now;

    const tone = (type, hz, t0, peak, decay, toHz = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(hz, t0);
      if (toHz) o.frequency.exponentialRampToValueAtTime(toHz, t0 + decay);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + decay);
      o.connect(g).connect(spat);
      o.start(t0); o.stop(t0 + decay + 0.02);
      autoDisconnect(o, [o, g]);
      nodes.push(o);
      end = Math.max(end, t0 + decay + 0.02);
      return o;
    };
    const noise = (hz, q, t0, peak, decay) => {
      const src = this._noiseSource(decay + 0.02);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = hz;
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + decay);
      src.connect(bp).connect(g).connect(spat);
      src.start(t0, src._offset); src.stop(t0 + decay + 0.02);
      autoDisconnect(src, [src, bp, g]);
      end = Math.max(end, t0 + decay + 0.02);
    };

    if (material === 'rope') {
      this._pulse(0.2 + p * 0.1);
      const hz = rand(62, 80) + p * 8;
      const o = tone('triangle', hz, now, 0.1 + p * 0.05, 0.55 + p * 0.1, hz * 0.86);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rand(6, 8);
      const depth = ctx.createGain();
      depth.gain.value = hz * 0.05;
      lfo.connect(depth).connect(o.frequency);
      lfo.start(now); lfo.stop(now + 0.7);
      autoDisconnect(lfo, [lfo, depth]);
      tone('sine', hz * 2.01, now, 0.04, 0.35);
      noise(900, 0.8, now, 0.03 + p * 0.02, 0.12);             // fibre creak
    } else if (material === 'steel') {
      this._pulse(0.5);
      const base = rand(200, 240);
      [1, 2.76, 5.4, 8.93].forEach((m, i) =>
        tone('sine', base * m, now, (0.09 - i * 0.018) * p, 1.1 - i * 0.22));
      noise(4200, 1.2, now, 0.08, 0.04);                        // strike click
    } else {
      this._pulse(0.35 + p * 0.2);
      tone('sine', rand(150, 190), now, 0.26 * Math.min(1.4, p), 0.12, 70);   // knock
      for (const hz of [420, 950, 2100]) noise(hz * rand(0.9, 1.1), 9, now, 0.12 * p, rand(0.08, 0.16));
      // Splinters: clicks thinning out as the pieces settle.
      const n = 4 + Math.round(p * 3);
      for (let i = 0; i < n; i++) {
        const t = now + 0.12 + Math.pow(i / n, 1.4) * 0.6 + rand(0, 0.04);
        noise(rand(1800, 4200), 3, t, 0.05 * (1 - i / n) + 0.01, 0.03);
      }
    }
    // Tear the shared spatializer down once every layer is done.
    const k = ctx.createConstantSource();
    k.start(now); k.stop(end + 0.05);
    autoDisconnect(k, [k, spat, spat.output].filter(Boolean));
  }

  // Press-row shutters: a mechanical click pair (curtain open, curtain close) per camera.
  shutter(count = 1) {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    for (let i = 0; i < count; i++) {
      const t0 = now + i * rand(0.03, 0.09) + rand(0, 0.02);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
      if (pan.pan) pan.pan.value = rand(-0.8, 0.8);
      pan.connect(this.sfxGain);
      for (const [dt, hz] of [[0, rand(3000, 3800)], [rand(0.02, 0.035), rand(2200, 2800)]]) {
        const src = this._noiseSource(0.03);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = hz;
        bp.Q.value = 2.5;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0 + dt);
        g.gain.linearRampToValueAtTime(0.035, t0 + dt + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0008, t0 + dt + 0.02);
        src.connect(bp).connect(g).connect(pan);
        src.start(t0 + dt, src._offset); src.stop(t0 + dt + 0.03);
        autoDisconnect(src, dt ? [src, bp, g, pan] : [src, bp, g]);
      }
    }
  }

  // Victory pyro: a CO2 jet's hiss sweeping down, over a low whump.
  pyro(worldPos = null) {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.5);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._connectSpat(this._spatializer(worldPos));
    const src = this._noiseSource(1.3);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(3200, now);
    bp.frequency.exponentialRampToValueAtTime(700, now + 1.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.14, now + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0008, now + 1.2);
    src.connect(bp).connect(g).connect(spat);
    src.start(now, src._offset); src.stop(now + 1.25);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(90, now);
    o.frequency.exponentialRampToValueAtTime(40, now + 0.25);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, now);
    og.gain.linearRampToValueAtTime(0.22, now + 0.01);
    og.gain.exponentialRampToValueAtTime(0.0008, now + 0.3);
    o.connect(og).connect(spat);
    o.start(now); o.stop(now + 0.32);
    autoDisconnect(o, [o, og]);
    autoDisconnect(src, [src, bp, g, spat, spat.output].filter(Boolean));
  }

  // Tape rewind into the next match: warbling chatter climbing in pitch, then the
  // transport's stop-clunk.
  rewind(dur = 0.75) {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = this._noiseSource(dur + 0.05);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 6;
    bp.frequency.setValueAtTime(900, now);
    bp.frequency.exponentialRampToValueAtTime(4200, now + dur);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 17;
    const depth = ctx.createGain();
    depth.gain.value = 500;
    lfo.connect(depth).connect(bp.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.09, now + 0.06);
    g.gain.setValueAtTime(0.09, now + dur - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0008, now + dur);
    src.connect(bp).connect(g).connect(this.sfxGain);
    src.start(now, src._offset); src.stop(now + dur + 0.02);
    lfo.start(now); lfo.stop(now + dur + 0.02);
    autoDisconnect(lfo, [lfo, depth]);
    autoDisconnect(src, [src, bp, g]);
    const clunk = ctx.createOscillator();
    clunk.type = 'triangle';
    clunk.frequency.setValueAtTime(160, now + dur);
    clunk.frequency.exponentialRampToValueAtTime(60, now + dur + 0.08);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, now + dur);
    cg.gain.linearRampToValueAtTime(0.16, now + dur + 0.004);
    cg.gain.exponentialRampToValueAtTime(0.0008, now + dur + 0.12);
    clunk.connect(cg).connect(this.sfxGain);
    clunk.start(now + dur); clunk.stop(now + dur + 0.14);
    autoDisconnect(clunk, [clunk, cg]);
  }

  // Glass giving way: a crack, then high inharmonic tinkles scattering as the
  // shards fall (the result-screen shatter).
  shatter() {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.6);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const crack = this._noiseSource(0.2);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, now);
    cg.gain.linearRampToValueAtTime(0.22, now + 0.003);
    cg.gain.exponentialRampToValueAtTime(0.0008, now + 0.18);
    crack.connect(hp).connect(cg).connect(this.sfxGain);
    crack.start(now, crack._offset); crack.stop(now + 0.2);
    autoDisconnect(crack, [crack, hp, cg]);
    for (let i = 0; i < 14; i++) {
      const t0 = now + 0.05 + Math.pow(Math.random(), 1.6) * 0.9;
      const o = ctx.createOscillator();
      o.frequency.value = rand(2800, 7200);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(rand(0.012, 0.03), t0 + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0005, t0 + rand(0.08, 0.2));
      o.connect(g).connect(this.sfxGain);
      o.start(t0); o.stop(t0 + 0.22);
      autoDisconnect(o, [o, g]);
    }
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

  // ══ Dynamic mix ══════════════════════════════════════════════════════

  /**
   * Ramp an AudioParam down and back to `base`. The setValueAtTime(param.value)
   * after cancelScheduledValues is load-bearing: without it a mid-ramp cancel
   * jumps to the last scheduled value and rapid hits zipper.
   */
  _duckParam(param, base, amount, hold = 0, release = DUCK_RELEASE) {
    const now = this.ctx.currentTime;
    const floor = Math.max(0, base * (1 - clamp(amount, 0, 1)));
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(floor, now + DUCK_ATTACK);
    if (hold > 0) param.setValueAtTime(floor, now + DUCK_ATTACK + hold);
    param.linearRampToValueAtTime(base, now + DUCK_ATTACK + hold + release);
  }

  /**
   * Sidechain the music under a landed hit (power 0..1). Depth 0.18 + 0.42·power:
   * a jab barely moves it, so normal exchanges don't stutter.
   */
  duckMusic(power = 1) {
    if (!this._ensure() || this.muted || !this.musicDuck) return;
    this._duckParam(this.musicDuck.gain, 1.0, 0.18 + 0.42 * clamp(power, 0, 1));
  }

  /**
   * "Ears ringing" after a heavy head hit or KO: muffle the SFX bus, hold, reopen,
   * with a tinnitus sine on top and the music ducked.
   * @param {number} strength 0..1 — how far the corner drops and how long it holds
   */
  concussion(strength = 1) {
    if (!this._ensure() || this.muted || !this.sfxFilter) return;
    const s = clamp(strength, 0, 1);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const hold = 0.18 + 0.5 * s;
    const corner = SFX_FILTER_OPEN - (SFX_FILTER_OPEN - SFX_FILTER_MUFFLED) * s;

    const f = this.sfxFilter.frequency;
    f.cancelScheduledValues(now);
    f.setValueAtTime(f.value, now);
    // Exponential: pitch is perceived logarithmically.
    f.exponentialRampToValueAtTime(Math.max(120, corner), now + 0.05);
    f.setValueAtTime(Math.max(120, corner), now + 0.05 + hold);
    f.exponentialRampToValueAtTime(SFX_FILTER_OPEN, now + 0.05 + hold + 0.55 + 0.5 * s);

    if (this.musicDuck) this._duckParam(this.musicDuck.gain, 1.0, 0.7 * s, hold, 0.6);

    // Tinnitus sine, randomized per call.
    const tone = ctx.createOscillator();
    tone.type = 'sine';
    tone.frequency.value = rand(3100, 4200);
    const tg = ctx.createGain();
    const dur = 0.05 + hold + 0.9;
    tg.gain.setValueAtTime(0.0001, now);
    tg.gain.linearRampToValueAtTime(0.016 * s, now + 0.08);
    tg.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    // Straight to master, bypassing the muffle it rings over.
    tone.connect(tg).connect(this.master);
    tone.start(now); tone.stop(now + dur + 0.02);
    autoDisconnect(tone, [tone, tg]);
  }

  /**
   * The "vacuum" during hit-pause (true on freeze, false on resume): pulls the
   * reverb so the room vanishes and slams back. Cheaper than M/S narrowing.
   */
  setHitstop(active) {
    if (!this._ensure() || !this.reverbGain) return;
    const want = active ? 1 : 0;
    if (want === this._hitstopDepth) return;
    this._hitstopDepth = want;
    const now = this.ctx.currentTime;
    const rv = this.reverbGain.gain;
    rv.cancelScheduledValues(now);
    rv.setValueAtTime(rv.value, now);
    rv.linearRampToValueAtTime(active ? 0.03 : 0.18, now + (active ? 0.015 : 0.12));
  }

  // ══ Crowd bed ════════════════════════════════════════════════════════
  // Three noise bands whose level and brightness track tension, and one-shot reactions.
  // The chanting is the rhythm section's (crowdStomp/crowdClap/crowdChant, below).

  startCrowd() {
    if (!this._ensure() || this.muted || this._crowdNodes) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // One looping source per band at its own offset, so the layers stay decorrelated.
    const loopSource = () => {
      const s = ctx.createBufferSource();
      s.buffer = this.noiseBuf;
      s.loop = true;
      s.start(now, Math.random() * Math.max(0.01, this.noiseBuf.duration - 0.05));
      return s;
    };

    // Swell VCA: one-shot reactions ride on top of the intensity level.
    const swell = ctx.createGain();
    swell.gain.value = 1.0;
    swell.connect(this.crowdGain);

    // Layer 1: room rumble, mono.
    const rumbleSrc = loopSource();
    const rumbleLp = ctx.createBiquadFilter();
    rumbleLp.type = 'lowpass';
    rumbleLp.frequency.value = 190;
    const rumbleG = ctx.createGain();
    rumbleG.gain.value = 0.9;
    rumbleSrc.connect(rumbleLp).connect(rumbleG).connect(swell);

    // Layer 2: chatter — the band intensity moves (level and centre frequency).
    const chatterSrc = loopSource();
    const chatterBp = ctx.createBiquadFilter();
    chatterBp.type = 'bandpass';
    chatterBp.frequency.value = 540;
    chatterBp.Q.value = 0.7;
    const chatterG = ctx.createGain();
    chatterG.gain.value = 1.0;
    const chatterPan = this._pan(-0.3);
    chatterSrc.connect(chatterBp).connect(chatterG).connect(chatterPan);
    (chatterPan.output || chatterPan).connect(swell);

    // Layer 3: hiss.
    const hissSrc = loopSource();
    const hissHp = ctx.createBiquadFilter();
    hissHp.type = 'highpass';
    hissHp.frequency.value = 3200;
    const hissG = ctx.createGain();
    hissG.gain.value = 0.22;
    const hissPan = this._pan(0.34);
    hissSrc.connect(hissHp).connect(hissG).connect(hissPan);
    (hissPan.output || hissPan).connect(swell);

    // (The old chant — a 1.15 Hz LFO on the chatter — is retired: the crowd's rhythm
    // section below, locked to the conductor, does the chanting now.)

    // Layer 4: the murmur — an uneasy low-mid babble that only the tournament's upset
    // storyline opens (setCrowdMood). Two unrelated slow LFOs on its level make it
    // surge and settle like a hall talking to itself, not a tremolo.
    const murmurSrc = loopSource();
    const murmurBp = ctx.createBiquadFilter();
    murmurBp.type = 'bandpass';
    murmurBp.frequency.value = 360;
    murmurBp.Q.value = 1.3;
    const murmurAm = ctx.createGain();
    murmurAm.gain.value = 0.6;
    const murmurG = ctx.createGain();
    murmurG.gain.value = 0;
    murmurSrc.connect(murmurBp).connect(murmurAm).connect(murmurG).connect(swell);
    const murmurLfos = [0.37, 0.91].map((hz, i) => {
      const o = ctx.createOscillator();
      o.frequency.value = hz;
      const d = ctx.createGain();
      d.gain.value = i ? 0.18 : 0.3;
      o.connect(d).connect(murmurAm.gain);
      o.start(now);
      return [o, d];
    });

    this._crowdNodes = {
      sources: [rumbleSrc, chatterSrc, hissSrc, murmurSrc, ...murmurLfos.map(([o]) => o)],
      chatterBp, swell, murmurG,
      all: [rumbleSrc, rumbleLp, rumbleG, chatterSrc, chatterBp, chatterG,
            chatterPan, chatterPan.output, hissSrc, hissHp, hissG, hissPan,
            hissPan.output, swell,
            murmurSrc, murmurBp, murmurAm, murmurG, ...murmurLfos.flat()].filter(Boolean),
    };
    this.setCrowdIntensity(this._crowdIntensity);
    this.setCrowdMood(this._crowdMood || 0);
  }

  // _spatializer, but taking a pan position directly.
  _pan(x) {
    const ctx = this.ctx;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(x, -1, 1);
      return p;
    }
    const splitL = ctx.createGain();
    const splitR = ctx.createGain();
    const merger = ctx.createChannelMerger(2);
    const angle = (clamp(x, -1, 1) + 1) * Math.PI / 4;
    splitL.gain.value = Math.cos(angle);
    splitR.gain.value = Math.sin(angle);
    const input = ctx.createGain();
    input.connect(splitL).connect(merger, 0, 0);
    input.connect(splitR).connect(merger, 0, 1);
    input.output = merger;
    return input;
  }

  /**
   * Crowd excitement — the same value that drives arena.js's animated crowd.
   * @param {number} t 0..1
   */
  setCrowdIntensity(t) {
    this._crowdIntensity = clamp(t, 0, 1);
    if (!this._crowdNodes || !this._ensure()) return;
    const now = this.ctx.currentTime;
    const i = this._crowdIntensity;
    this._crowdBase = CROWD_BASE_GAIN + (CROWD_PEAK_GAIN - CROWD_BASE_GAIN) * i;
    const g = this.crowdGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(this.muted ? 0 : this._crowdBase, now + 0.6);
    // Brighten as it gets louder: 540 Hz murmur → 1150 Hz roar.
    const bp = this._crowdNodes.chatterBp.frequency;
    bp.cancelScheduledValues(now);
    bp.setValueAtTime(bp.value, now);
    bp.linearRampToValueAtTime(540 + 610 * i, now + 0.6);
  }

  /** Roar on a big landed hit. `power` 0..1. */
  crowdSwell(power = 1) {
    if (!this._crowdNodes || !this._ensure() || this.muted) return;
    const now = this.ctx.currentTime;
    const p = clamp(power, 0, 1);
    const s = this._crowdNodes.swell.gain;
    s.cancelScheduledValues(now);
    s.setValueAtTime(s.value, now);
    // Fast up, slow down.
    s.linearRampToValueAtTime(1 + 2.4 * p, now + 0.11);
    s.linearRampToValueAtTime(1, now + 0.11 + 0.7 + 0.5 * p);
  }

  /** Sharp intake of breath — a near-KO, a sever, a whiffed super. */
  crowdGasp() {
    if (!this._ensure() || this.muted || !this.crowdGain) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.55;
    const src = this._noiseSource(dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.6;
    // The rise-fall contour is what makes it a gasp.
    bp.frequency.setValueAtTime(700, now);
    bp.frequency.linearRampToValueAtTime(1750, now + 0.16);
    bp.frequency.linearRampToValueAtTime(900, now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.5, now + 0.07);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(bp).connect(g).connect(this.crowdGain);
    src.start(now, src._offset); src.stop(now + dur);
    autoDisconnect(src, [src, bp, g]);
  }

  // ══ Tournament storyline (cup.js) ════════════════════════════════════
  // The crowd reading the Elo story: murmurs while the underdog leads, boos while a
  // heavy favourite cruises, a long roar for an upset, and a stadium slap-back on the
  // heavy hits of a high-upset moment. All synthesized, all on the crowd/sfx buses.

  /**
   * The hall's mood, -1..1: above 0 the underdog leads (the murmur layer opens with it),
   * below 0 the favourite is cruising (nothing continuous: crowdBoo carries that).
   */
  setCrowdMood(level) {
    this._crowdMood = clamp(level, -1, 1);
    if (!this._crowdNodes?.murmurG || !this._ensure()) return;
    const now = this.ctx.currentTime;
    const g = this._crowdNodes.murmurG.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(this.muted ? 0 : 0.85 * Math.max(0, this._crowdMood), now + 0.9);
  }

  /**
   * A wave of boos: a chorus of detuned sawtooth "oo" voices through two vowel formants,
   * swelling in and sagging in pitch as it dies. `strength` 0..1.
   */
  crowdBoo(strength = 1) {
    if (!this._ensure() || this.muted || !this.crowdGain) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const s = clamp(strength, 0, 1);
    const dur = 1.4 + 0.8 * s;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, now);
    bus.gain.linearRampToValueAtTime(0.5 + 0.5 * s, now + 0.35);
    bus.gain.setValueAtTime(0.5 + 0.5 * s, now + dur - 0.6);
    bus.gain.exponentialRampToValueAtTime(0.0008, now + dur);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass'; f1.frequency.value = 320; f1.Q.value = 3;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass'; f2.frequency.value = 820; f2.Q.value = 4;
    const f2g = ctx.createGain();
    f2g.gain.value = 0.35;
    bus.connect(f1).connect(this.crowdGain);
    bus.connect(f2).connect(f2g).connect(this.crowdGain);
    const voices = 9;
    const nodes = [bus, f1, f2, f2g];
    for (let i = 0; i < voices; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const f0 = rand(105, 175);
      const t0 = now + rand(0, 0.25);
      o.frequency.setValueAtTime(f0, t0);
      o.frequency.linearRampToValueAtTime(f0 * rand(0.86, 0.93), now + dur);
      o.detune.value = rand(-25, 25);
      const vg = ctx.createGain();
      vg.gain.value = 0.11 / Math.sqrt(voices);
      o.connect(vg).connect(bus);
      o.start(t0); o.stop(now + dur + 0.05);
      autoDisconnect(o, i === voices - 1 ? [o, vg, ...nodes] : [o, vg]);
    }
  }

  /**
   * A long, sustained roar (an upset decided, the champion crowned): the swell VCA held
   * high for `holdSec`, with a bright "hey!" cheer band riding over it.
   */
  crowdRoar(power = 1, holdSec = 2.5) {
    if (!this._crowdNodes || !this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const p = clamp(power, 0, 1);
    const s = this._crowdNodes.swell.gain;
    s.cancelScheduledValues(now);
    s.setValueAtTime(s.value, now);
    s.linearRampToValueAtTime(1 + 3.2 * p, now + 0.3);
    s.setValueAtTime(1 + 3.2 * p, now + 0.3 + holdSec);
    s.linearRampToValueAtTime(1, now + 0.3 + holdSec + 2.2);
    const end = now + 0.3 + holdSec + 1.6;
    const src = this._noiseSource(Math.min(1.9, end - now));
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(1300, now);
    bp.frequency.linearRampToValueAtTime(2100, now + 0.4);
    bp.frequency.linearRampToValueAtTime(1500, end);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.45 * p, now + 0.25);
    g.gain.setValueAtTime(0.45 * p, end - 1.2);
    g.gain.exponentialRampToValueAtTime(0.0008, end);
    src.connect(bp).connect(g).connect(this.crowdGain);
    src.start(now, src._offset); src.stop(end + 0.05);
    autoDisconnect(src, [src, bp, g]);
  }

  // The slap-back: the sfx bus feeds a 140 ms delay with a little feedback, through a
  // band-limit (the far stands), and a gate that is shut unless slapback() opens it.
  // Built on first use; the feedback loop idles silently behind the shut gate.
  _echo() {
    if (this._echoNodes || !this.sfxFilter) return this._echoNodes;
    const ctx = this.ctx;
    const delay = ctx.createDelay(0.5);
    delay.delayTime.value = 0.14;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2600;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 160;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const gate = ctx.createGain();
    gate.gain.value = 0;
    this.sfxFilter.connect(delay);
    delay.connect(lp).connect(hp);
    hp.connect(fb).connect(delay);
    hp.connect(gate).connect(this.master);
    this._echoNodes = { gate, all: [delay, lp, hp, fb, gate] };
    return this._echoNodes;
  }

  /** Open the stadium slap-back for the hit that just landed. `amount` 0..1. */
  slapback(amount = 1) {
    if (!this._ensure() || this.muted) return;
    const e = this._echo();
    if (!e) return;
    const now = this.ctx.currentTime;
    const g = e.gate.gain;
    const peak = 0.75 * clamp(amount, 0, 1);
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(peak, now + 0.01);
    g.setValueAtTime(peak, now + 0.5);
    g.linearRampToValueAtTime(0, now + 1.3);
  }

  /** A confetti cannon in the rafters: the sub thump, the blast and the paper hiss after it. */
  cannonBoom(worldPos = null) {
    if (!this._ensure() || this.muted) return;
    this._pulse(0.4);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._connectSpat(this._spatializer(worldPos));
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(rand(62, 76), now);
    o.frequency.exponentialRampToValueAtTime(26, now + 0.45);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, now);
    og.gain.linearRampToValueAtTime(0.5, now + 0.008);
    og.gain.exponentialRampToValueAtTime(0.0008, now + 0.6);
    o.connect(og).connect(spat);
    o.start(now); o.stop(now + 0.62);
    autoDisconnect(o, [o, og]);
    const blast = this._noiseSource(0.5);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, now);
    lp.frequency.exponentialRampToValueAtTime(260, now + 0.4);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, now);
    bg.gain.linearRampToValueAtTime(0.32, now + 0.004);
    bg.gain.exponentialRampToValueAtTime(0.0008, now + 0.45);
    blast.connect(lp).connect(bg).connect(spat);
    blast.start(now, blast._offset); blast.stop(now + 0.5);
    autoDisconnect(blast, [blast, lp, bg]);
    // The paper: a soft high hiss drifting down for a second.
    const paper = this._noiseSource(1.3);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 4200;
    const pg = ctx.createGain();
    pg.gain.setValueAtTime(0.0001, now + 0.08);
    pg.gain.linearRampToValueAtTime(0.03, now + 0.25);
    pg.gain.exponentialRampToValueAtTime(0.0006, now + 1.25);
    paper.connect(hp).connect(pg).connect(spat);
    paper.start(now + 0.08, paper._offset); paper.stop(now + 1.3);
    autoDisconnect(paper, [paper, hp, pg, spat, spat.output].filter(Boolean));
  }

  stopCrowd() {
    if (!this._crowdNodes) return;
    for (const s of this._crowdNodes.sources) { try { s.stop(); } catch { /* */ } }
    // Loops never fire onended, so autoDisconnect can't clean this graph.
    for (const n of this._crowdNodes.all) { try { n.disconnect(); } catch { /* */ } }
    this._crowdNodes = null;
  }

  // ══ PA announcer ═════════════════════════════════════════════════════
  // CONSTRAINT: speechSynthesis renders straight to the output device and cannot
  // be routed into an AudioContext, so no bus processing applies. The PA feel comes
  // from voice/pitch/rate, a mic-key click + thump through the bus, and ducking.
  announce(text, { rate = 0.92, pitch = 0.62, volume = 1, duckSec = 1.1 } = {}) {
    if (this.muted || !text) return;
    this._paKey();
    if (this._ensure()) {
      if (this.musicDuck) this._duckParam(this.musicDuck.gain, 1.0, 0.62, duckSec, 0.5);
      if (this.crowdDuck) this._duckParam(this.crowdDuck.gain, 1.0, 0.45, duckSec, 0.5);
    }
    const synth = typeof window !== 'undefined' && window.speechSynthesis;
    if (!synth) return; // no Web Speech — the mic key + duck still land
    try {
      // Drop any backlog: a late "K.O." is worse than none.
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickAnnouncerVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = rate;
      u.pitch = pitch;
      u.volume = volume;
      this._speaking = true;
      u.onend = u.onerror = () => { this._speaking = false; };
      synth.speak(u);
    } catch { this._speaking = false; }
  }

  /** Mic-key click + cabinet thump: the sound of a PA opening up. */
  _paKey() {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const tick = this._noiseSource(0.05);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 2.2;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, now);
    tg.gain.linearRampToValueAtTime(0.09, now + 0.004);
    tg.gain.exponentialRampToValueAtTime(0.0005, now + 0.05);
    tick.connect(bp).connect(tg).connect(this.sfxGain);
    tick.start(now, tick._offset); tick.stop(now + 0.06);
    autoDisconnect(tick, [tick, bp, tg]);
    // Cabinet thump.
    const th = ctx.createOscillator();
    th.type = 'sine';
    th.frequency.setValueAtTime(120, now);
    th.frequency.exponentialRampToValueAtTime(52, now + 0.14);
    const thg = ctx.createGain();
    thg.gain.setValueAtTime(0.0001, now);
    thg.gain.linearRampToValueAtTime(0.11, now + 0.01);
    thg.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    th.connect(thg).connect(this.sfxGain);
    th.start(now); th.stop(now + 0.22);
    autoDisconnect(th, [th, thg]);
  }

  stopAnnounce() {
    this._speaking = false;
    try { window.speechSynthesis?.cancel(); } catch { /* */ }
  }

  // Super stinger: tape-stop, sub drop under the freeze, then the owner's leitmotif as a
  // brass stinger (charId given — the show bus calls first, with the owner), or the old
  // detuned minor chord without one. personalityEffects.js calls again with no owner a
  // moment later; inside SUPER_DEDUPE_SEC that is the same super, so it never doubles.
  superStinger(charId = null) {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (now - this._superAt < SUPER_DEDUPE_SEC) return;
    this._superAt = now;

    // 1. Tape stop: falling bandpassed noise.
    const stopDur = 0.42;
    const tape = this._noiseSource(stopDur);
    const tbp = ctx.createBiquadFilter();
    tbp.type = 'bandpass';
    tbp.Q.value = 1.4;
    tbp.frequency.setValueAtTime(4200, now);
    tbp.frequency.exponentialRampToValueAtTime(180, now + stopDur);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, now);
    tg.gain.linearRampToValueAtTime(0.16, now + 0.03);
    tg.gain.exponentialRampToValueAtTime(0.001, now + stopDur);
    tape.connect(tbp).connect(tg).connect(this.sfxGain);
    tape.start(now, tape._offset); tape.stop(now + stopDur);
    autoDisconnect(tape, [tape, tbp, tg]);

    // 2. Sub drop under the hit-pause.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(180, now);
    sub.frequency.exponentialRampToValueAtTime(31, now + 0.7);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, now);
    sg.gain.linearRampToValueAtTime(0.5, now + 0.02);
    sg.gain.exponentialRampToValueAtTime(0.001, now + 1.0);
    sub.connect(sg).connect(this.sfxGain);
    sub.start(now); sub.stop(now + 1.05);
    autoDisconnect(sub, [sub, sg]);

    // 3a. The owner's motif, fast, in brass doubled a fifth under — 0.18 s in, out of the
    // tape stop — with its last note held as the stinger's tail.
    const chordAt = now + 0.18;
    const motif = charId && MOTIFS[charId];
    if (motif) {
      this.playMotif(charId, { at: chordAt, sixteenth: 0.075, timbre: 'brass', peak: 0.11, hold: 0.9 });
      this.playMotif(charId, { at: chordAt, sixteenth: 0.075, timbre: 'brass', peak: 0.06, transpose: -7, hold: 0.9 });
      this._pulse(1.0);
      this.crowdSwell(1.0);
      return;
    }

    // 3b. Chord: minor triad, three detuned saws per note, opening lowpass; 0.18 s in.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(320, chordAt);
    lp.frequency.exponentialRampToValueAtTime(5200, chordAt + 0.5);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, chordAt);
    cg.gain.linearRampToValueAtTime(0.13, chordAt + 0.08);
    cg.gain.exponentialRampToValueAtTime(0.001, chordAt + 1.5);
    lp.connect(cg).connect(this.sfxGain);
    for (const hz of [110, 130.81, 329.63]) {         // A2, C3, E4
      for (const cents of [-7, 0, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz;
        o.detune.value = cents;
        o.connect(lp);
        o.start(chordAt); o.stop(chordAt + 1.55);
        autoDisconnect(o, [o]);
      }
    }
    // Shared filter/gain torn down off a sentinel that outlives every note.
    const last = ctx.createConstantSource();
    last.start(chordAt); last.stop(chordAt + 1.6);
    autoDisconnect(last, [last, lp, cg]);

    this._pulse(1.0);
    this.crowdSwell(1.0);
  }

  // Music stem: two synthesized loops crossfaded by HP.
  startMusic() {
    if (!this._ensure() || this.musicNodes) return;
    const ctx = this.ctx;
    const tempo = 96; // bpm
    const beat = 60 / tempo;

    // Two gains: bassEnv (per-note, scheduler) and bassLevel (setMusicTension, which
    // cancelScheduledValues and would otherwise wipe queued notes).
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

    // Lookahead scheduler: the timer only decides when to queue; note times come
    // off the audio clock.
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
      // After a stall, skip missed beats (staying on the grid) rather than cram
      // them all into one instant.
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

    // Pad: filtered noise with a slow LFO on cutoff.
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

  // 0..1 toward the "low-HP" stem: quieter bass, louder pad.
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

  // Round-start riff for charId (an INTRO_THEMES key) on introGain, ducking the loop.
  // Restarts any in-flight intro.
  playIntroTheme(charId) {
    if (!this._ensure() || this.muted) return;
    const theme = INTRO_THEMES[charId];
    if (!theme || !this.introGain) return;
    // The countdown's leitmotif exchange (countdownMotifs) owns this countdown: a riff
    // on top of it would be two tunes in two keys under the PA.
    if (this.ctx.currentTime < (this._introSuppressUntil || 0)) return;

    this.stopIntroTheme();

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const beatDur = 60 / theme.bpm;

    let melodyBeats = 0, bassBeats = 0;
    for (const [, d] of theme.melody) melodyBeats += d;
    if (theme.bass) for (const [, d] of theme.bass) bassBeats += d;
    const totalDur = Math.max(melodyBeats, bassBeats) * beatDur;

    // Duck and restore in audio time, so tab throttling can't strand it.
    if (this.musicGain) {
      this._introRestoreVol = this.musicGain.gain.value;
      this.musicGain.gain.cancelScheduledValues(now);
      this.musicGain.gain.linearRampToValueAtTime(0.08, now + 0.08);
      const restoreAt = now + totalDur + 0.15;
      this.musicGain.gain.linearRampToValueAtTime(this._introRestoreVol, restoreAt + 0.35);
    }

    const created = [];

    // Lead: two detuned squares.
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

  // Idempotent.
  stopIntroTheme() {
    if (!this.introNodes) return;
    const ctx = this.ctx;
    const now = ctx ? ctx.currentTime : 0;
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

  // Combo melody: each hit in a run rings one step up A minor pentatonic (the
  // music loop's key), a mallet voice layered on the impact. The impact itself lands
  // on the frame of contact; only this mallet snaps to the conductor's next 8th/16th
  // (setConductor), never more than ~120 ms late, so a run rings out in time.
  comboNote(n, worldPos = null) {
    if (n < 2 || !this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime + this._gridDelay();
    const PENTA = [0, 3, 5, 7, 10];               // A C D E G
    const deg = Math.min(n - 2, 11);              // tops out two octaves up
    const semis = PENTA[deg % 5] + 12 * Math.floor(deg / 5);
    const f0 = 440 * Math.pow(2, semis / 12);
    const spat = this._connectSpat(this._spatializer(worldPos));
    const voice = (hz, peak, decay) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(peak, now + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0008, now + decay);
      o.connect(g).connect(spat);
      o.start(now); o.stop(now + decay + 0.03);
      return [o, g];
    };
    const lift = Math.min(1, 0.55 + deg * 0.06);
    const [o1, g1] = voice(f0, 0.07 * lift, 0.42);
    const [o2, g2] = voice(f0 * 2.76, 0.022 * lift, 0.16);
    autoDisconnect(o2, [o2, g2]);
    // The longer fundamental owns tearing down the shared spatializer.
    autoDisconnect(o1, [o1, g1, spat, spat.output].filter(Boolean));
  }

  // Run of 4+ expiring: a rising Am(add9) arpeggio resolving the combo phrase.
  comboFinisher(n) {
    if (n < 4 || !this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const notes = [220, 261.63, 329.63, 493.88, 440];  // A3 C4 E4 B4 A4
    const peak = Math.min(0.075, 0.04 + n * 0.004);
    notes.forEach((hz, i) => {
      const t0 = now + i * 0.055;
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.7);
      o.connect(g).connect(this.sfxGain);
      o.start(t0); o.stop(t0 + 0.75);
      autoDisconnect(o, [o, g]);
    });
    this.crowdSwell(0.5);
  }

  // One lub-dub; game.js owns the tempo (shared with the screen-edge pulse).
  heartbeat(strength = 1) {
    if (!this._ensure() || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const s = clamp(strength, 0, 1);
    const thump = (t0, peak) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(62, t0);
      o.frequency.exponentialRampToValueAtTime(38, t0 + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.2);
      // Straight to master so it survives the concussion lowpass.
      o.connect(g).connect(this.master);
      o.start(t0); o.stop(t0 + 0.22);
      autoDisconnect(o, [o, g]);
    };
    thump(now, 0.3 * s);
    thump(now + 0.17, 0.2 * s);
  }

  /** 0..1 — how close the nearer fighter is to a KO. Sinks the music under a lowpass. */
  setDanger(level) {
    if (!this.musicLP || !this.ctx) return;
    const d = clamp(level, 0, 1);
    // Exponential sweep, 20 kHz → ~700 Hz.
    const hz = d < 0.01 ? SFX_FILTER_OPEN : 700 * Math.pow(SFX_FILTER_OPEN / 700, 1 - d);
    this.musicLP.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.25);
  }

  // VS splash: riser into a sub boom + clang at 0.45 s, when the splash CSS slams
  // the name cards together.
  vsSting() {
    // Running-only: nodes queued on a suspended context would fire mid-fight on resume.
    if (!this._ensure() || this.muted || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const hitAt = now + 0.45;

    const riseDur = 0.45;
    const rise = this._noiseSource(riseDur);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(900, now);
    hp.frequency.exponentialRampToValueAtTime(5200, hitAt);
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.0001, now);
    rg.gain.exponentialRampToValueAtTime(0.14, hitAt - 0.01);
    rg.gain.linearRampToValueAtTime(0.0001, hitAt + 0.02);
    rise.connect(hp).connect(rg).connect(this.sfxGain);
    rise.start(now, rise._offset); rise.stop(hitAt + 0.03);
    autoDisconnect(rise, [rise, hp, rg]);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(120, hitAt);
    sub.frequency.exponentialRampToValueAtTime(34, hitAt + 0.5);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, hitAt);
    sg.gain.linearRampToValueAtTime(0.5, hitAt + 0.015);
    sg.gain.exponentialRampToValueAtTime(0.0008, hitAt + 0.8);
    sub.connect(sg).connect(this.sfxGain);
    sub.start(hitAt); sub.stop(hitAt + 0.85);
    autoDisconnect(sub, [sub, sg]);

    // Clang: three inharmonic square partials through a bandpass.
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 2.2;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, hitAt);
    cg.gain.linearRampToValueAtTime(0.06, hitAt + 0.005);
    cg.gain.exponentialRampToValueAtTime(0.0008, hitAt + 0.9);
    bp.connect(cg).connect(this.sfxGain);
    for (const hz of [311, 523, 887]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = hz;
      o.connect(bp);
      o.start(hitAt); o.stop(hitAt + 0.95);
      autoDisconnect(o, [o]);
    }
    const last = ctx.createConstantSource();
    last.start(hitAt); last.stop(hitAt + 1.0);
    autoDisconnect(last, [last, bp, cg]);
    this._pulse(0.6);
  }

  // Breaking-news "da-da-da-DAAA": brass stabs to a held fifth over a timpani roll.
  newsSting() {
    if (!this._ensure() || this.muted || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const now = ctx.currentTime + 0.02;
    const stab = (t0, freqs, dur, peak) => {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(900, t0);
      lp.frequency.exponentialRampToValueAtTime(4200, t0 + 0.05);
      lp.frequency.exponentialRampToValueAtTime(1600, t0 + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.012);
      g.gain.setValueAtTime(peak, t0 + dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      lp.connect(g).connect(this.sfxGain);
      for (const hz of freqs) {
        for (const cents of [-6, 6]) {
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = hz;
          o.detune.value = cents;
          o.connect(lp);
          o.start(t0); o.stop(t0 + dur + 0.02);
          autoDisconnect(o, [o]);
        }
      }
      const end = ctx.createConstantSource();
      end.start(t0); end.stop(t0 + dur + 0.05);
      autoDisconnect(end, [end, lp, g]);
    };
    const e = 0.16;
    stab(now, [440, 659.25], 0.12, 0.05);              // A4 + E5
    stab(now + e, [440, 659.25], 0.12, 0.05);
    stab(now + e * 2, [493.88, 739.99], 0.12, 0.055);  // B4 + F#5
    stab(now + e * 3, [587.33, 880], 1.1, 0.065);      // D5 + A5, held

    for (let i = 0; i < 8; i++) {
      const t0 = now + i * (e * 3 / 8);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(98, t0);
      o.frequency.exponentialRampToValueAtTime(72, t0 + 0.08);
      const g = ctx.createGain();
      const pk = 0.05 + i * 0.025;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(pk, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + (i === 7 ? 0.9 : 0.12));
      o.connect(g).connect(this.sfxGain);
      o.start(t0); o.stop(t0 + (i === 7 ? 0.95 : 0.14));
      autoDisconnect(o, [o, g]);
    }
  }

  // ══ Showtime (audioShow.js) ══════════════════════════════════════════
  // Driven by the show bus. The conductor is audioShow's silent clock; the AudioBus only
  // asks it how far the next grid line is (setConductor) and schedules on the audio clock.

  /** `fn()` → seconds to the conductor's next 8th/16th; null detaches. */
  setConductor(fn) { this._grid = typeof fn === 'function' ? fn : null; }

  // Quantize delay for a melodic layer: the conductor's answer, trusted only inside ~120 ms.
  _gridDelay() {
    const d = this._grid ? this._grid() : 0;
    return d > 0 && d < 0.13 ? d : 0;
  }

  /**
   * The camera's perspective on the mix: 'tight' | 'mid' | 'wide' | 'ko' (PERSPECTIVES).
   * Every stage glides with setTargetAtTime, so a hard cut is heard as a move, not a click.
   * Mix state only (no sound of its own), so it is recorded while muted too.
   */
  setPerspective(name) {
    const p = PERSPECTIVES[name];
    // Before the context exists the graph is built at 'mid'; recorded only once applied.
    if (!p || name === this._persp || !this.perspEq || !this.ctx) return;
    this._persp = name;
    this._glide(this.perspSend.gain, p.send, PERSP_TAU);
    this._glide(this.perspEq.gain, p.thump, PERSP_TAU);
    this._glide(this.perspHc.frequency, p.hc, PERSP_TAU);
    // The hall swells and recedes a little slower than the close-up sound.
    this._glide(this.crowdPersp.gain, p.crowd, PERSP_TAU * 2);
  }

  // setTargetAtTime from where the param is NOW. The cancel + anchor is load-bearing: a
  // glide chained onto an earlier, still-converging one was measured never to leave it.
  _glide(param, v, tau) {
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.setTargetAtTime(v, now, tau);
  }

  /**
   * null → the side-on StereoPanner mix; 'HRTF' | 'equalpower' → one-shots get a PannerNode
   * heard from the AudioListener that setListener keeps on the camera.
   */
  setListenerMode(mode) {
    this._listenerMode = mode === 'HRTF' || mode === 'equalpower' ? mode : null;
  }

  /** Put the AudioListener on the camera: position, forward and up (world space). */
  setListener(px, py, pz, fx, fy, fz, ux, uy, uz) {
    const L = this.ctx?.listener;
    if (!L) return;
    if (L.positionX) {
      L.positionX.value = px; L.positionY.value = py; L.positionZ.value = pz;
      L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
      L.upX.value = ux; L.upY.value = uy; L.upZ.value = uz;
    } else {
      L.setPosition(px, py, pz);
      L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  // A stinger phrase's output: a fixed pan into stingGain, torn down once `end` passes.
  _stingOut(pan, at, end) {
    const out = this._pan(pan);
    (out.output || out).connect(this.stingGain);
    const k = this.ctx.createConstantSource();
    k.start(at); k.stop(end + 0.05);
    autoDisconnect(k, [k, out, out.output].filter(Boolean));
    return out;
  }

  /**
   * One note in a named timbre into `dest`; returns when it is silent.
   *   sustained: brass (two saws, filter swell) · reed (square, warm) · sax (saw, scooped,
   *              mid band) · organ (three drawbar sines) · chip (staccato square)
   *   struck:    keys (sine + soft octave) · twang (saw, closing filter) · pluck (triangle)
   *              · bell (sine + the 2.76 bar partial)
   */
  _tone(timbre, hz, t0, dur, peak, dest) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.connect(dest);
    let head = g;
    const extra = [g];
    const oscs = [];
    const osc = (type, f, cents = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      if (cents) o.detune.value = cents;
      oscs.push(o);
      return o;
    };
    const filter = (type, q) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.Q.value = q;
      f.connect(g);
      head = f;
      extra.push(f);
      return f;
    };
    const end = t0 + dur;
    let sustained = true, atk = 0.02, ring = 0;
    switch (timbre) {
      case 'brass': {
        const lp = filter('lowpass', 1.2);
        lp.frequency.setValueAtTime(hz * 1.2, t0);
        lp.frequency.exponentialRampToValueAtTime(Math.min(9000, hz * 7), t0 + 0.05);
        lp.frequency.exponentialRampToValueAtTime(Math.min(6000, hz * 3.5), end + 0.05);
        osc('sawtooth', hz, -6); osc('sawtooth', hz, 6);
        atk = 0.025;
        break;
      }
      case 'reed': {
        filter('lowpass', 0.7).frequency.value = Math.min(3500, hz * 4);
        osc('square', hz);
        atk = 0.015;
        break;
      }
      case 'sax': {
        filter('bandpass', 0.8).frequency.value = 1300;
        const o = osc('sawtooth', hz);
        o.frequency.setValueAtTime(hz * 0.96, t0);
        o.frequency.linearRampToValueAtTime(hz, t0 + 0.04);
        peak *= 1.8; // the band throws most of the saw away
        break;
      }
      case 'organ':
        osc('sine', hz); osc('sine', hz * 2); osc('triangle', hz * 3);
        peak *= 0.55; atk = 0.008;
        break;
      case 'chip':
        osc('square', hz);
        peak *= 0.6; atk = 0.003;
        break;
      case 'keys':
        osc('sine', hz); osc('triangle', hz * 2);
        sustained = false; ring = Math.max(0.6, dur * 1.4); peak *= 0.8;
        break;
      case 'twang': {
        const lp = filter('lowpass', 2);
        lp.frequency.setValueAtTime(Math.min(9000, hz * 8), t0);
        lp.frequency.exponentialRampToValueAtTime(hz * 1.5, t0 + 0.18);
        const o = osc('sawtooth', hz);
        o.frequency.setValueAtTime(hz * 0.98, t0);
        o.frequency.linearRampToValueAtTime(hz, t0 + 0.03);
        sustained = false; ring = Math.max(0.45, dur * 1.2);
        break;
      }
      case 'pluck':
        osc('triangle', hz); osc('sine', hz * 2);
        sustained = false; ring = Math.max(0.35, dur);
        break;
      default: // 'bell'
        osc('sine', hz); osc('sine', hz * 2.76);
        sustained = false; ring = Math.max(0.9, dur * 1.5); peak *= 0.8;
        break;
    }
    const gp = g.gain;
    gp.setValueAtTime(0.0001, t0);
    let stopAt;
    if (sustained) {
      gp.linearRampToValueAtTime(peak, t0 + atk);
      gp.linearRampToValueAtTime(peak * 0.8, Math.max(t0 + atk + 0.005, end));
      gp.exponentialRampToValueAtTime(0.0008, end + 0.07);
      stopAt = end + 0.09;
    } else {
      gp.linearRampToValueAtTime(peak, t0 + 0.004);
      gp.exponentialRampToValueAtTime(0.0008, t0 + ring);
      stopAt = t0 + ring + 0.02;
    }
    oscs.forEach((o, i) => {
      o.connect(head);
      o.start(t0); o.stop(stopAt);
      autoDisconnect(o, i === oscs.length - 1 ? [o, ...extra] : [o]);
    });
    return stopAt;
  }

  /**
   * A president's leitmotif (MOTIFS; unknown ids get DEFAULT_MOTIF). Returns its end time.
   * @param {object} o  at (audio time), sixteenth (s), fit (squeeze the phrase into this many
   *   seconds), timbre (override), peak, transpose (semitones), pan, hold (extra seconds on
   *   the last note), dest (a node to feed instead of a fresh panned stinger output)
   */
  playMotif(charId, { at = 0, sixteenth = 0.11, fit = 0, timbre = null, peak = 0.1,
    transpose = 0, pan = 0, hold = 0, dest = null } = {}) {
    if (!this._ensure() || this.muted) return 0;
    const m = MOTIFS[charId] || DEFAULT_MOTIF;
    const start = Math.max(at, this.ctx.currentTime);
    let total = 0;
    for (const d of m.durs) total += d;
    const six = fit > 0 ? Math.min(sixteenth, fit / total) : sixteenth;
    const root = noteToFreq(m.root) * Math.pow(2, transpose / 12);
    // Rough length up front for the output's teardown sentinel (a struck tail rings ~1 s).
    const out = dest || this._stingOut(pan, start, start + total * six + hold + 1.4);
    let t = start, end = start;
    m.notes.forEach((semi, i) => {
      const last = i === m.notes.length - 1;
      const d = m.durs[i] * six * (last ? 1 : 0.9) + (last ? hold : 0);
      // Accent the downbeat and the landing note.
      const pk = peak * (i === 0 || last ? 1 : 0.82);
      end = Math.max(end, this._tone(timbre || m.timbre, root * Math.pow(2, semi / 12), t, d, pk, out));
      t += m.durs[i] * six;
    });
    return end;
  }

  // The motif's root dropped into the brass's sweet octave (F3..E4) for chords.
  _chordRoot(charId) {
    let hz = noteToFreq((MOTIFS[charId] || DEFAULT_MOTIF).root);
    while (hz > 330) hz /= 2;
    while (hz < 165) hz *= 2;
    return hz;
  }

  // A snare roll from t0 to t1 swelling to `peak`: one noise source, one envelope with a
  // stroke every 32nd-triplet — three nodes for the whole roll, not one per stroke.
  _snareRoll(t0, t1, peak, dest) {
    const ctx = this.ctx;
    const src = this._noiseSource(Math.min(1.9, t1 - t0 + 0.1));
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    const step = 0.034;
    for (let t = t0, i = 0; t < t1; t += step, i++) {
      const a = peak * (0.3 + 0.7 * (t - t0) / Math.max(0.01, t1 - t0)) * (i % 2 ? 0.8 : 1);
      g.gain.setValueAtTime(a, t);
      g.gain.exponentialRampToValueAtTime(a * 0.12, t + step * 0.9);
    }
    g.gain.exponentialRampToValueAtTime(0.0005, t1 + 0.08);
    src.connect(bp).connect(g).connect(dest || this.stingGain);
    src.start(t0, src._offset); src.stop(t1 + 0.1);
    autoDisconnect(src, [src, bp, g]);
  }

  /**
   * The countdown's call and response. The PA calls "3" at once, "2" at 1 s, "1" at 2 s and
   * "Fight!" at 3 s (game.js _tick), so each corner's motif sits in the gap after a number —
   * P1 from the left after "3", P2 answering from the right after "2" — and a snare roll
   * swells from "1" into "Fight!". Takes over the countdown from playIntroTheme.
   */
  countdownMotifs(c1, c2) {
    // Running-only: nodes queued on a suspended context would fire mid-fight on resume.
    if (!this._ensure() || this.muted || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    this._introSuppressUntil = now + 0.5;
    this.playMotif(c1, { at: now + 0.4, fit: 0.6, sixteenth: 0.12, pan: -0.5, peak: 0.14 });
    this.playMotif(c2, { at: now + 1.4, fit: 0.6, sixteenth: 0.12, pan: 0.5, peak: 0.14 });
    this._snareRoll(now + 2.42, now + 2.97, 0.09);
  }

  /**
   * The winner's motif resolved as a fanfare: the phrase in its own voice over a brass
   * octave, then the tonic major chord held over a timpani stroke. `delay` lets the news
   * sting (newsSting, fired by the same result) finish first.
   */
  fanfare(charId, delay = 1.5) {
    if (!this._ensure() || this.muted || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const at = ctx.currentTime + delay;
    const six = 0.1;
    const end = Math.max(
      this.playMotif(charId, { at, sixteenth: six, peak: 0.1 }),
      this.playMotif(charId, { at, sixteenth: six, timbre: 'brass', transpose: -12, peak: 0.07 }));
    const m = MOTIFS[charId] || DEFAULT_MOTIF;
    let total = 0;
    for (const d of m.durs) total += d;
    const chordAt = at + total * six + 0.02;
    const root = this._chordRoot(charId);
    const dur = 1.3;
    const out = this._stingOut(0, chordAt, Math.max(end, chordAt + dur + 0.2));
    [0, 7, 12, 16, 19].forEach((semi, i) =>
      this._tone('brass', root * Math.pow(2, semi / 12), chordAt, dur, i ? 0.045 : 0.06, out));
    this._timpani(chordAt, 0.3, root / 2);
  }

  // One timpani stroke: a pitched sine thud that sags a little, over a felt-mallet tick.
  _timpani(t0, peak, hz = 98) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(hz * 1.04, t0);
    o.frequency.exponentialRampToValueAtTime(hz * 0.97, t0 + 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + 1.1);
    o.connect(g).connect(this.stingGain);
    o.start(t0); o.stop(t0 + 1.15);
    autoDisconnect(o, [o, g]);
  }

  /**
   * Momentum swing: a short brass chord stab in the new leader's key when the HP lead flips
   * on a big hit. Snapped to the conductor's next 8th/16th. `power` 0..1.
   */
  brassStab(charId, power = 1, worldPos = null) {
    if (!this._ensure() || this.muted) return;
    const p = clamp(power, 0, 1);
    const at = this.ctx.currentTime + this._gridDelay();
    const pan = worldPos ? clamp(worldPos.x / ARENA_HALF_WIDTH, -1, 1) * 0.5 : 0;
    const out = this._stingOut(pan, at, at + 0.4);
    const root = this._chordRoot(charId);
    const voicing = p > 0.7 ? [0, 7, 12, 16] : [0, 7, 12];
    for (const semi of voicing) {
      this._tone('brass', root * Math.pow(2, semi / 12), at, 0.14, 0.04 + 0.04 * p, out);
    }
  }

  /**
   * The champion's honours — "Ruffles and Flourishes" (US military honours, public domain):
   * a drum ruffle under a bugle flourish up and down the Bb bugle notes, twice, landing
   * on a held chord. Plays when the belt ceremony's PA call is through.
   */
  flourish() {
    if (!this._ensure() || this.muted || this.ctx.state !== 'running') return;
    const at = this.ctx.currentTime + 0.05;
    const BUGLE = ['F4', 'Bb4', 'D5', 'F5', 'D5', 'Bb4', 'F4', 'Bb4', 'D5', 'F5'];
    const step = 0.085;
    const phrase = BUGLE.length * step + 0.35;
    const out = this._stingOut(0, at, at + phrase * 2 + 1.8);
    for (let r = 0; r < 2; r++) {
      const t0 = at + r * phrase;
      this._snareRoll(t0, t0 + phrase - 0.15, 0.08);
      BUGLE.forEach((n, i) => {
        const last = i === BUGLE.length - 1;
        this._tone('brass', noteToFreq(n), t0 + i * step, last ? 0.3 : step * 0.85, last ? 0.09 : 0.075, out);
      });
    }
    const chordAt = at + phrase * 2;
    for (const [n, pk] of [['Bb3', 0.06], ['F4', 0.05], ['Bb4', 0.05], ['D5', 0.045], ['F5', 0.04]]) {
      this._tone('brass', noteToFreq(n), chordAt, 1.4, pk, out);
    }
    this._timpani(chordAt, 0.32, noteToFreq('Bb1'));
    this._pulse(0.6);
  }

  /**
   * A charge-up riser, panned to `worldPos` and followed via handle.set(amt, pos): three
   * Shepard partials an octave apart climbing two octaves as the coil fills (the bottom one
   * fades in as the top one fades out, so it keeps "rising"), over band-passed noise
   * sweeping 500 Hz → 4 kHz and narrowing. handle.ping() is the full-charge glint;
   * handle.stop(amt) snaps it shut with a whoosh scaled by the charge. A dead-man fade
   * re-armed on every set() silences it within 0.5 s if its owner stops updating (a hidden
   * tab, a crashed handler), so it can never drone. Returns null while muted.
   * @param {number} level loudness 0..1 (the CPU corners run quieter)
   */
  chargeRiser(worldPos = null, level = 1) {
    if (!this._ensure() || this.muted) return null;
    if (this._risers.size >= MAX_RISERS) this._risers.values().next().value.stop(0);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._connectSpat(this._spatializer(worldPos));
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(spat);
    const partials = [0, 1, 2].map((k) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 70 * Math.pow(2, k); // where set(0) puts it: no opening chirp
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g).connect(out);
      o.start(now);
      return { o, g };
    });
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    const ng = ctx.createGain();
    noise.connect(bp).connect(ng).connect(out);
    noise.start(now, Math.random() * (this.noiseBuf.duration - 0.05));
    const all = [noise, bp, ng, out, spat, spat.output, ...partials.flatMap((p) => [p.o, p.g])].filter(Boolean);

    const bus = this;
    const h = {
      amt: 0, level: clamp(level, 0, 1), pos: worldPos, alive: true,
      _partials: partials, // read by diagnostics only
      set(amt, pos = null) {
        if (!h.alive || !bus.ctx) return;
        const t = bus.ctx.currentTime;
        h.amt = clamp(amt, 0, 1);
        if (pos) { h.pos = pos; bus._moveSpat(spat, pos); }
        const lift = 2 * h.amt;                                // octaves climbed
        for (let k = 0; k < 3; k++) {
          const oct = k + lift;                                // 0..4 across the band
          const w = Math.sin(Math.PI * oct / 4);
          bus._glide(partials[k].o.frequency, 70 * Math.pow(2, oct), 0.04);
          bus._glide(partials[k].g.gain, 0.34 * w * w, 0.04);
        }
        bus._glide(bp.frequency, 500 * Math.pow(2, 3 * h.amt), 0.04);
        bus._glide(bp.Q, 1.5 + 5 * h.amt, 0.04);
        bus._glide(ng.gain, 0.4 + 1.4 * h.amt, 0.04);
        // The dead-man: up to the level, then a fade to silence that the next set() cancels.
        const lvl = (0.025 + 0.075 * h.amt) * h.level;
        const gp = out.gain;
        gp.cancelScheduledValues(t);
        gp.setValueAtTime(gp.value, t);
        gp.linearRampToValueAtTime(lvl, t + 0.05);
        gp.linearRampToValueAtTime(0, t + 0.5);
      },
      ping() {
        if (!h.alive || bus.muted || !bus.ctx) return;
        bus._glint(h.pos, h.level);
      },
      stop(amt = h.amt) {
        if (!h.alive) return;
        h.alive = false;
        bus._risers.delete(h);
        if (!bus.ctx) return;
        const t = bus.ctx.currentTime;
        const gp = out.gain;
        gp.cancelScheduledValues(t);
        gp.setValueAtTime(gp.value, t);
        gp.linearRampToValueAtTime(0, t + 0.035);
        for (const p of partials) { try { p.o.stop(t + 0.05); } catch { /* */ } }
        try { noise.stop(t + 0.05); } catch { /* */ }
        autoDisconnect(noise, all);
        if (amt > 0.12 && !bus.muted) bus._riserSnap(h.pos, clamp(amt, 0, 1) * h.level, 500 * Math.pow(2, 3 * amt));
      },
    };
    this._risers.add(h);
    h.set(0, worldPos);
    return h;
  }

  // The full-charge glint: a high inharmonic "ting" with a click on the front.
  _glint(pos, level) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._connectSpat(this._spatializer(pos));
    const parts = [[2637, 0.05, 0.5], [3951, 0.03, 0.3], [5274, 0.016, 0.18]];
    parts.forEach(([hz, pk, dec], i) => {
      const o = ctx.createOscillator();
      o.frequency.value = hz * rand(0.99, 1.01);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(pk * level, now + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0005, now + dec);
      o.connect(g).connect(spat);
      o.start(now); o.stop(now + dec + 0.02);
      autoDisconnect(o, i === 0 ? [o, g, spat, spat.output].filter(Boolean) : [o, g]);
    });
    this._pulse(0.2);
  }

  // The riser let go: a crack on the front and a whoosh falling from where the riser was.
  _riserSnap(pos, a, fromHz) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const spat = this._connectSpat(this._spatializer(pos));
    const dur = 0.12 + 0.2 * a;
    const sweep = this._noiseSource(dur + 0.03);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.6;
    bp.frequency.setValueAtTime(fromHz, now);
    bp.frequency.exponentialRampToValueAtTime(220, now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.16 * a, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0006, now + dur);
    sweep.connect(bp).connect(g).connect(spat);
    sweep.start(now, sweep._offset); sweep.stop(now + dur + 0.02);
    autoDisconnect(sweep, [sweep, bp, g, spat, spat.output].filter(Boolean));
    const crack = this._noiseSource(0.05);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2400;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, now);
    cg.gain.linearRampToValueAtTime(0.14 * a, now + 0.003);
    cg.gain.exponentialRampToValueAtTime(0.0005, now + 0.035);
    crack.connect(hp).connect(cg).connect(spat);
    crack.start(now, crack._offset); crack.stop(now + 0.045);
    autoDisconnect(crack, [crack, hp, cg]);
  }

  /** Stop every live charge riser at once (mute, reset, teardown). */
  stopRisers() {
    for (const h of [...this._risers]) h.stop(0);
  }

  /**
   * The rhythm section's level 0..1 (stomp-clap and chant ride under it). Fades, never
   * steps: up over ~2 s, down over ~1.5 s.
   */
  setCrowdRhythm(level) {
    if (!this.rhythmGain || !this.ctx) return;
    const v = this.muted ? 0 : clamp(level, 0, 1);
    if (Math.abs(v - (this._rhythmLevel ?? -1)) < 0.01) return;
    const rising = v > (this._rhythmLevel ?? 0);
    this._rhythmLevel = v;
    const now = this.ctx.currentTime;
    const g = this.rhythmGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(v, now, rising ? 0.7 : 0.5);
  }

  /** The bleachers: a few hundred feet on wood, at audio time `at`, loosely together. */
  crowdStomp(at, amt = 1) {
    if (!this._ensure() || this.muted || !this.rhythmGain) return;
    const ctx = this.ctx;
    for (let i = 0; i < 2; i++) {
      const t = at + rand(0, 0.03);
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(rand(78, 96), t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.linearRampToValueAtTime(0.16 * amt, t + 0.008);
      og.gain.exponentialRampToValueAtTime(0.0008, t + 0.2);
      o.connect(og).connect(this.rhythmGain);
      o.start(t); o.stop(t + 0.22);
      autoDisconnect(o, [o, og]);
      const n = this._noiseSource(0.2);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = rand(240, 320);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, t);
      ng.gain.linearRampToValueAtTime(0.32 * amt, t + 0.005);
      ng.gain.exponentialRampToValueAtTime(0.0008, t + 0.15);
      n.connect(lp).connect(ng).connect(this.rhythmGain);
      n.start(t, n._offset); n.stop(t + 0.17);
      autoDisconnect(n, [n, lp, ng]);
    }
  }

  /** The hall's clap: thousands of hands, so a 30 ms smear of micro-bursts, not one click. */
  crowdClap(at, amt = 1) {
    if (!this._ensure() || this.muted || !this.rhythmGain) return;
    const ctx = this.ctx;
    const src = this._noiseSource(0.3);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = rand(1300, 1700);
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    for (const [dt, k] of [[0, 1], [0.009, 0.85], [0.019, 0.75], [0.031, 0.55]]) {
      const t = at + dt + rand(0, 0.003);
      g.gain.setValueAtTime(1.9 * amt * k, t);
      g.gain.exponentialRampToValueAtTime(0.37 * amt * k, t + 0.008);
    }
    g.gain.exponentialRampToValueAtTime(0.0008, at + 0.2);
    src.connect(bp).connect(g).connect(this.rhythmGain);
    src.start(at, src._offset); src.stop(at + 0.22);
    autoDisconnect(src, [src, bp, g]);
  }

  /**
   * One syllable of the "U-S-A!" chant: `voices` detuned sawtooth throats (a mixed crowd,
   * 130-280 Hz, each a little late) through three vowel formants gliding through the
   * syllable — "you" /i/→/u/, "ess" /ɛ/ closing on an /s/ hiss, "ay" /e/→/i/. Synthesized,
   * not speechSynthesis, because speech can't be mixed, ducked or put in the room.
   */
  crowdChant(syl, at, amt = 1, voices = 6) {
    if (!this._ensure() || this.muted || !this.rhythmGain) return;
    const v = CHANT_VOWELS[syl];
    if (!v) return;
    const ctx = this.ctx;
    const dur = v.dur;
    const vowelEnd = v.sib ? at + dur * 0.5 : at + dur;
    const sum = ctx.createGain();
    sum.gain.value = 1 / Math.sqrt(voices);
    const env = ctx.createGain();
    env.connect(this.rhythmGain);
    const nodes = [sum, env];
    v.f.forEach(([from, to], i) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = [5, 8, 10][i];
      bp.frequency.setValueAtTime(from, at);
      bp.frequency.linearRampToValueAtTime(to, at + (vowelEnd - at) * 0.85);
      const fg = ctx.createGain();
      fg.gain.value = [1, 0.6, 0.3][i];
      sum.connect(bp).connect(fg).connect(env);
      nodes.push(bp, fg);
    });
    const peak = 0.6 * amt;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.linearRampToValueAtTime(peak, at + 0.05);
    env.gain.setValueAtTime(peak, Math.max(at + 0.05, vowelEnd - 0.06));
    env.gain.exponentialRampToValueAtTime(0.0008, vowelEnd + 0.08);
    for (let i = 0; i < voices; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const f0 = rand(130, 280);
      const t0 = at + rand(0, 0.05);
      o.frequency.setValueAtTime(f0 * 0.92, t0);
      o.frequency.linearRampToValueAtTime(f0, t0 + 0.06);
      o.frequency.linearRampToValueAtTime(f0 * 0.88, vowelEnd + 0.08);
      o.detune.value = rand(-25, 25);
      o.connect(sum);
      o.start(t0); o.stop(vowelEnd + 0.1);
      autoDisconnect(o, [o]);
    }
    const end = vowelEnd + 0.12;
    if (v.sib) {
      // The /s/: the whole hall hissing through its teeth, slightly ragged at the front.
      const s = this._noiseSource(dur * 0.6 + 0.1);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3600;
      const sg = ctx.createGain();
      const s0 = at + dur * 0.42;
      sg.gain.setValueAtTime(0.0001, s0);
      sg.gain.linearRampToValueAtTime(0.9 * amt, s0 + 0.04);
      sg.gain.setValueAtTime(0.9 * amt, at + dur - 0.03);
      sg.gain.exponentialRampToValueAtTime(0.0008, at + dur + 0.07);
      s.connect(hp).connect(sg).connect(this.rhythmGain);
      s.start(s0, s._offset); s.stop(at + dur + 0.09);
      autoDisconnect(s, [s, hp, sg]);
    }
    const k = ctx.createConstantSource();
    k.start(at); k.stop(end);
    autoDisconnect(k, [k, ...nodes]);
  }

  /**
   * A convention balloon popping at world-x `worldX`, size `size` (1 = a party balloon;
   * bigger is lower and louder): the skin's crack, the air's "thup", and a rubbery squeak
   * of the torn skin snapping back. A drop pops dozens at once, so past MAX_POPS live
   * voices a pop is dropped rather than stacking nodes.
   */
  balloonPop(worldX = 0, size = 1) {
    if (!this._ensure() || this.muted || this._popVoices >= MAX_POPS) return;
    this._popVoices++;
    const ctx = this.ctx;
    const s = clamp(size, 0.4, 2.5);
    const sq = Math.sqrt(s);
    const now = ctx.currentTime + rand(0, 0.008);
    const spat = this._connectSpat(this._spatializer({ x: worldX, y: 4, z: 0 }));
    // 1. The crack.
    const crack = this._noiseSource(0.08);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1400 / sq;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, now);
    cg.gain.linearRampToValueAtTime(0.32 * Math.min(1.4, s), now + 0.0015);
    cg.gain.exponentialRampToValueAtTime(0.0006, now + 0.03 + 0.02 * s);
    crack.connect(hp).connect(cg).connect(spat);
    crack.start(now, crack._offset); crack.stop(now + 0.07);
    autoDisconnect(crack, [crack, hp, cg]);
    // 2. The air going: a low thup.
    const thup = ctx.createOscillator();
    thup.frequency.setValueAtTime(300 / sq * rand(0.9, 1.1), now);
    thup.frequency.exponentialRampToValueAtTime(90, now + 0.05);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, now);
    tg.gain.linearRampToValueAtTime(0.16 * Math.min(1.6, s), now + 0.003);
    tg.gain.exponentialRampToValueAtTime(0.0006, now + 0.08);
    thup.connect(tg).connect(spat);
    thup.start(now); thup.stop(now + 0.09);
    autoDisconnect(thup, [thup, tg]);
    // 3. The squeak: the rubber snapping back, a quick up-down-up wobble.
    const f = rand(900, 1300) / sq;
    const t0 = now + 0.012;
    const sqk = ctx.createOscillator();
    sqk.type = 'triangle';
    sqk.frequency.setValueAtTime(f, t0);
    sqk.frequency.linearRampToValueAtTime(f * 1.25, t0 + 0.028);
    sqk.frequency.linearRampToValueAtTime(f * 0.8, t0 + 0.068);
    sqk.frequency.linearRampToValueAtTime(f * 1.1, t0 + 0.1);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t0);
    sg.gain.linearRampToValueAtTime(0.03, t0 + 0.008);
    sg.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.13);
    sqk.connect(sg).connect(spat);
    sqk.start(t0); sqk.stop(t0 + 0.14);
    // The last layer out tears the spatializer down and frees the voice.
    autoDisconnect(sqk, [sqk, sg, spat, spat.output].filter(Boolean), () => { this._popVoices--; });
  }

  /**
   * The finished mix as a MediaStream, for the KO clip recorder. Null until the
   * context exists (no gesture yet) — clip.js asks again on each recorder restart.
   */
  tapStream() {
    if (!this.ctx || !this.out || this._ensureFailed) return null;
    if (!this._tap) {
      try {
        this._tap = this.ctx.createMediaStreamDestination();
        this.out.connect(this._tap);
      } catch { this._tap = null; return null; }
    }
    return this._tap.stream;
  }

  close() {
    this.stopMusic();
    this.stopIntroTheme();
    this.stopCrowd();
    this.stopAnnounce();
    this.stopRisers();
    this._grid = null;
    // The listener belongs to the shared app context: hand it back at the origin.
    if (this._listenerMode) {
      this.setListener(0, 0, 0, 0, 0, -1, 0, 1, 0);
      this._listenerMode = null;
    }
    // The slap-back's feedback loop would otherwise idle on the shared context forever.
    if (this._echoNodes) {
      for (const n of this._echoNodes.all) { try { n.disconnect(); } catch { /* */ } }
      this._echoNodes = null;
    }
    if (this.ctx) {
      // Never close the shared app context (js/audioBus.js); only a private fallback.
      if (this._ownsCtx && this.ctx.state !== 'closed') {
        this.ctx.close().catch(() => { /* already closing */ });
      } else {
        // Detach our chain from the shared bus.
        try { this.master?.disconnect(); } catch { /* already disconnected */ }
      }
      this.ctx = null;
    }
    if (this._tap) { try { this.out?.disconnect(this._tap); } catch { /* */ } this._tap = null; }
    this.master = this.sfxGain = this.musicGain = this.reverbGain = this.introGain = null;
    this.sfxFilter = this.musicDuck = this.musicLP = this.crowdGain = this.crowdDuck = null;
    this.stingGain = this.rhythmGain = this.crowdPersp = null;
    this.perspEq = this.perspHc = this.perspSend = this._convolver = null;
    this.out = null;
    this.noiseBuf = null;
  }
}

export { AudioBus };