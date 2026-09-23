// leitmotif.js — the genome synth (GFX pass 2, idea 5).
//
// The creature the camera is on — the director's subject, or the one the player follows —
// gets a short motif of its own, played quietly from where it stands. The motif is not
// picked from a list: it is COMPOSED from the creature's five base traits, the same five
// the frame already carries for the evolution tint.
//
//   boldness     → leap size. A bold wolf's motif jumps; a timid rabbit's steps.
//   curiosity    → length and rhythm. Curious creatures get longer, more syncopated lines.
//   greed        → brightness (the filter opens).
//   diligence    → articulation. Diligent is legato; idle is clipped.
//   sociability  → harmony. A social creature's accented notes are doubled a third below.
//   species      → timbre and register: rabbit a high pluck, deer a breathy flute, wolf a
//                  low reed, human a wooden mallet.
//
// KIN SOUND LIKE KIN
// The contour (which way each note moves) is seeded from the traits quantised COARSELY,
// and the ornaments from them quantised finely. Traits are inherited with a small
// mutation (TRAIT_MUTATION_SIGMA), so a parent and child usually share a contour and
// differ in the ornaments — you can hear a family line — and a lineage that has drifted
// far enough eventually sounds like someone else. Nothing here reads the lineage; the
// genetics do the work.
//
// Everything is scaled onto the adaptive score's own root and mode (music.js), on its own
// tempo, one phrase every two bars, so the motif is always a voice in the piece rather
// than a second piece playing over it.
import { ROOT_HZ, SCALES } from './music.js';

const LOOKAHEAD_MS = 150;
const SCHEDULE_AHEAD = 0.6;
const PHRASE_BEATS = 8;
const LEVEL = 0.09;

// Per species: octave offset (semitones above the score's root), and a voice builder.
const REGISTER = [24, 12, 0, 12];

const mulberry = (seed) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const quantKey = (traits, steps) => traits.reduce((h, v) => (h * 31 + Math.round(Math.max(0, Math.min(1, v)) * steps)) | 0, 7);

/**
 * Compose a motif from a species and five traits (0..1).
 * @returns {{ notes: {deg:number, beats:number, accent:boolean}[], legato:number, bright:number, harmony:boolean }}
 */
export function composeMotif(species, traits) {
  const [bold, social, curious, greed, diligent] = traits;
  const contour = mulberry(quantKey(traits, 3) ^ (species * 7919));
  const ornament = mulberry(quantKey(traits, 10) ^ (species * 104729));
  const length = 4 + Math.round(curious * 3);
  const maxStep = 1 + Math.round(bold * 3);
  const RHYTHMS = curious > 0.6 ? [0.5, 0.5, 1, 0.75, 0.25, 1] : curious > 0.3 ? [1, 0.5, 0.5, 1] : [1, 1];
  const notes = [];
  let deg = 0;
  for (let i = 0; i < length; i++) {
    if (i > 0) {
      const dir = contour() < 0.5 ? -1 : 1;
      const step = 1 + Math.floor(contour() * maxStep);
      deg = Math.max(-3, Math.min(9, deg + dir * step));
    }
    // An ornament is a neighbour-note grace, decided by the fine key — the part of the
    // motif that mutates first.
    const beats = RHYTHMS[i % RHYTHMS.length];
    notes.push({ deg, beats, accent: i === 0 || beats >= 1 });
    if (ornament() < 0.22 && i < length - 1) notes.push({ deg: deg + (ornament() < 0.5 ? 1 : -1), beats: 0.25, accent: false });
  }
  // Home: the last note falls to the nearest root or fifth, so every motif resolves.
  const last = notes[notes.length - 1];
  last.deg = Math.abs(last.deg - 4) < Math.abs(last.deg) ? 4 : 0;
  last.beats = Math.max(last.beats, 1);
  return { notes, legato: 0.35 + diligent * 0.6, bright: 900 + greed * 3200, harmony: social > 0.6 };
}

export function createLeitmotif(audio, music) {
  let timer = null;
  let subject = null;         // { handle, species, traits, x, y, z }
  let motif = null;
  let nextPhraseAt = 0;

  const ctx = () => audio.context;

  function freq(deg, octaveShift, mode) {
    const scale = SCALES[mode] ?? SCALES.dorian;
    const o = Math.floor(deg / 7); const d = ((deg % 7) + 7) % 7;
    return ROOT_HZ * Math.pow(2, (scale[d] + o * 12 + octaveShift) / 12);
  }

  /** One note in the species' timbre, into `dest`, at `when`, for `dur` seconds. */
  function voice(dest, species, when, f, dur, level, bright) {
    const c = ctx();
    const g = c.createGain();
    const filt = c.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = bright; filt.Q.value = 0.7;
    filt.connect(g).connect(dest);
    const osc = c.createOscillator();
    let attack = 0.01; let release = dur;
    if (species === 0) { osc.type = 'triangle'; attack = 0.004; release = Math.min(dur, 0.35); }          // rabbit: pluck
    else if (species === 1) {                                                                            // deer: flute
      osc.type = 'sine'; attack = 0.06;
      const vib = c.createOscillator(); vib.frequency.value = 4.6;
      const depth = c.createGain(); depth.gain.value = f * 0.006;
      vib.connect(depth).connect(osc.frequency); vib.start(when); vib.stop(when + dur + 0.3);
      const breath = c.createBufferSource();
      const len = Math.floor(c.sampleRate * 0.25); const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      breath.buffer = buf;
      const bf = c.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = f * 2; bf.Q.value = 3;
      const bg = c.createGain(); bg.gain.value = level * 0.25;
      breath.connect(bf).connect(bg).connect(dest); breath.start(when);
    } else if (species === 2) { osc.type = 'sawtooth'; attack = 0.05; filt.frequency.value = Math.min(bright, 1400); }  // wolf: reed
    else {                                                                                               // human: mallet
      osc.type = 'sine'; attack = 0.003; release = Math.min(dur, 0.6);
      const over = c.createOscillator(); over.type = 'sine'; over.frequency.value = f * 3.98;
      const og = c.createGain();
      og.gain.setValueAtTime(level * 0.35, when); og.gain.exponentialRampToValueAtTime(0.0001, when + 0.12);
      over.connect(og).connect(dest); over.start(when); over.stop(when + 0.15);
    }
    osc.frequency.value = f;
    osc.connect(filt);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(level, when + attack);
    g.gain.setTargetAtTime(0, when + Math.max(attack, release * 0.6), Math.max(0.03, release * 0.25));
    osc.start(when); osc.stop(when + release + 0.6);
  }

  function playPhrase(when) {
    if (!motif || !subject) return;
    const placed = audio.placeNode(subject.x, subject.y + 1, subject.z, { wet: 0.4, ref: 10, rolloff: 1 });
    if (!placed) return;
    const state = music.state;
    const beat = 60 / (state.bpm || 54);
    const octave = REGISTER[subject.species] ?? 12;
    let t = when + placed.dist / (audio.speedOfSound || 343);
    for (const n of motif.notes) {
      const dur = n.beats * beat * motif.legato;
      const level = LEVEL * (n.accent ? 1 : 0.7);
      voice(placed.node, subject.species, t, freq(n.deg, octave, state.mode), dur, level, motif.bright);
      if (motif.harmony && n.accent) voice(placed.node, subject.species, t, freq(n.deg - 2, octave, state.mode), dur, level * 0.5, motif.bright);
      t += n.beats * beat;
    }
  }

  function tick() {
    const c = ctx();
    if (!c || !music.running || !subject || !motif) return;
    const beat = 60 / (music.state.bpm || 54);
    if (nextPhraseAt < c.currentTime) nextPhraseAt = c.currentTime + 0.3;
    if (nextPhraseAt < c.currentTime + SCHEDULE_AHEAD) {
      try { playPhrase(nextPhraseAt); } catch { /* audio is best-effort */ }
      nextPhraseAt += PHRASE_BEATS * beat;
    }
  }

  return {
    /** The creature on camera, or null. Called at the stats cadence and on every cut. */
    setSubject(s) {
      if (!s) { subject = null; motif = null; return; }
      const changed = !subject || subject.handle !== s.handle;
      subject = s;
      if (changed) {
        motif = composeMotif(s.species, s.traits);
        // A new subject is introduced on the next beat or so, not after a two-bar wait —
        // the cut and the motif should land together.
        const c = ctx();
        if (c) nextPhraseAt = c.currentTime + 0.35;
      }
      if (!timer) timer = setInterval(tick, LOOKAHEAD_MS);
    },
    get subject() { return subject ? subject.handle : -1; },
    get motif() { return motif; },
    dispose() { if (timer) { clearInterval(timer); timer = null; } subject = null; motif = null; },
  };
}
