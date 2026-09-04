// music.js — the adaptive score (GFX option 10).
//
// PoEcosystem is a watch-it game: sessions are twenty minutes of nothing happening
// punctuated by a wolf pack finding a herd. Silence makes that read as idle; a looping
// track makes it read as a screensaver. What it wants is a score that KNOWS, and this game
// has a richer state signal than anything else in the app to give one — population,
// birth and death rates, extinctions, fire, event pressure and the time of day.
//
// The whole score is four synthesised layers on the ambience's own AudioContext:
//
//   DRONE   a root/fifth pair, always present, rising with tension. The floor of the piece.
//   PAD     three detuned saws through a slow filter, voicing a triad from the current
//           mode. This is the layer that carries the mood.
//   PULSE   a slow plucked figure, only while the island is actually growing. Its absence
//           is the point: when the pulse stops, something is wrong, and the player feels
//           that several seconds before the population sparkline shows it.
//   RUMBLE  filtered noise under a crisis — a firestorm, an eruption, an extinction.
//
// MODE IS THE STORY
// Rather than crossfading "happy" and "sad" stems, the pad and pulse are re-voiced into a
// different mode as the world turns: Ionian while thriving, Dorian while stable, Aeolian
// while declining, Phrygian in a collapse. Same notes, same tempo, different world.
//
// Oscillators are created ONCE and re-tuned with setTargetAtTime. Rebuilding them per
// chord is the obvious implementation and it clicks on every change.
const SCALES = {
  ionian: [0, 2, 4, 5, 7, 9, 11],      // thriving
  dorian: [0, 2, 3, 5, 7, 9, 10],      // stable — minor, but with a hopeful sixth
  aeolian: [0, 2, 3, 5, 7, 8, 10],     // declining
  phrygian: [0, 1, 3, 5, 7, 8, 10],    // collapse; the flat second is the whole effect
};

// A slow degree walk. Never random: an ambient bed that wanders freely stops sounding
// composed, and this progression resolves home every fourth chord.
const PROGRESSION = [0, 5, 3, 4, 0, 2, 5, 4];

const ROOT_HZ = 110;                   // A2 — low enough to sit under everything else
const LOOKAHEAD_MS = 120;
const SCHEDULE_AHEAD = 0.55;

const semi = (n) => ROOT_HZ * Math.pow(2, n / 12);

export function createMusic(audio) {
  let ctx = null;
  let bus = null;
  let droneGain = null; let padGain = null; let pulseGain = null; let rumbleGain = null;
  let padFilter = null;
  const padOsc = [];
  const droneOsc = [];
  let timer = null;
  let nextNoteAt = 0;
  let step = 0;
  let chordIndex = 0;
  let stoppedAppMusic = false;
  let enabled = true;

  // World-driven parameters, all 0..1, all smoothed towards their targets so the score
  // never lurches when a single stats message reports a bad half-second.
  const world = { tension: 0, hope: 0.4, night: 0, alive: 0 };
  const target = { tension: 0, hope: 0.4, night: 0 };
  let mode = 'dorian';
  let bpm = 54;

  const reduceMotion = typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduce';

  function build() {
    ctx = audio.context;
    if (!ctx) return false;
    bus = ctx.createGain();
    bus.gain.value = 0;                 // faded in by the first apply()
    bus.connect(audio.musicDestination);

    // Drone: root and fifth, one octave down, slightly detuned against each other so the
    // pair beats slowly instead of sitting as a dead sine.
    droneGain = ctx.createGain(); droneGain.gain.value = 0.05;
    droneGain.connect(bus);
    for (const [mult, detune] of [[0.5, -4], [0.75, 5]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = ROOT_HZ * mult;
      o.detune.value = detune;
      const g = ctx.createGain(); g.gain.value = mult === 0.5 ? 1 : 0.55;
      o.connect(g).connect(droneGain);
      o.start();
      droneOsc.push({ osc: o, mult });
    }

    // Pad: three saws through a lazy low-pass. The filter LFO is what keeps a sustained
    // chord alive over the thirty seconds it may be held.
    padGain = ctx.createGain(); padGain.gain.value = 0.045;
    padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass'; padFilter.frequency.value = 700; padFilter.Q.value = 0.8;
    padFilter.connect(padGain).connect(bus);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.045;
    const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 260;
    lfo.connect(lfoDepth).connect(padFilter.frequency);
    lfo.start();
    for (let v = 0; v < 3; v++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = semi(v * 4);
      o.detune.value = (v - 1) * 7;     // a few cents apart: width without chorus
      const g = ctx.createGain(); g.gain.value = 0.33;
      o.connect(g).connect(padFilter);
      o.start();
      padOsc.push(o);
    }

    // Pulse: silent bus; plucks are scheduled onto it by tick().
    pulseGain = ctx.createGain(); pulseGain.gain.value = 0;
    pulseGain.connect(bus);

    // Rumble: noise through a resonant low-pass, only audible in a crisis.
    rumbleGain = ctx.createGain(); rumbleGain.gain.value = 0;
    rumbleGain.connect(bus);
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b0 = 0.995 * b0 + 0.03 * w; d[i] = b0 * 3; }
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 90; lp.Q.value = 3.5;
    src.connect(lp).connect(rumbleGain);
    src.start();

    nextNoteAt = ctx.currentTime + 0.2;
    return true;
  }

  /** Re-voice the pad onto the current mode and progression step. */
  function voice() {
    if (!padOsc.length) return;
    const scale = SCALES[mode];
    const degree = PROGRESSION[chordIndex % PROGRESSION.length];
    const triad = [0, 2, 4].map((k) => scale[(degree + k) % 7] + (degree + k >= 7 ? 12 : 0));
    const t = ctx.currentTime;
    padOsc.forEach((o, k) => {
      // A slow glide rather than a jump: at this tempo the ear reads the slide as a
      // deliberate swell, and it is also what stops the sawtooth from clicking.
      o.frequency.setTargetAtTime(semi(triad[k] + 12), t, 1.4);
    });
    for (const d of droneOsc) d.osc.frequency.setTargetAtTime(ROOT_HZ * d.mult * Math.pow(2, scale[degree] / 12), t, 2.2);
  }

  function pluck(when, semitone) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = semi(semitone + 24);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(0.5, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 1.1);
    o.connect(g).connect(pulseGain);
    o.start(when); o.stop(when + 1.2);
  }

  /** Ease the live parameters toward the world's, then push them into the graph. */
  function apply() {
    const k = 0.06;
    world.tension += (target.tension - world.tension) * k;
    world.hope += (target.hope - world.hope) * k;
    world.night += (target.night - world.night) * k;

    const nextMode = world.tension > 0.62 ? 'phrygian'
      : world.tension > 0.34 ? 'aeolian'
        : world.hope > 0.55 ? 'ionian' : 'dorian';
    if (nextMode !== mode) { mode = nextMode; voice(); }

    bpm = 48 + world.hope * 22;
    const t = ctx.currentTime;
    bus.gain.setTargetAtTime(enabled ? 1 : 0, t, 0.8);
    droneGain.gain.setTargetAtTime(0.045 + world.tension * 0.085, t, 1.5);
    padGain.gain.setTargetAtTime(0.040 + world.hope * 0.028 + world.night * 0.018, t, 1.5);
    // The pulse is gated, not faded: "the island stopped singing" has to be an event, and
    // a gentle fade to zero is not one.
    pulseGain.gain.setTargetAtTime(world.hope > 0.3 && world.tension < 0.5 ? 0.05 : 0, t, 1.2);
    rumbleGain.gain.setTargetAtTime(world.tension * world.tension * 0.1, t, 0.9);
  }

  /** Lookahead scheduler — the standard WebAudio pattern, at ambient tempo. */
  function tick() {
    if (!ctx) return;
    apply();
    // The app's generic soundtrack would play straight over this. It is stopped on start,
    // but musicDirector arms a one-shot gesture kick that can start it afterwards, so the
    // check is repeated here rather than done once.
    if (stoppedAppMusic && window.PoAmbientMusic?.isPlaying?.()) {
      try { window.PoAmbientMusic.stop(); } catch { /* the soundtrack is never load-bearing */ }
    }
    const beat = 60 / bpm;
    while (nextNoteAt < ctx.currentTime + SCHEDULE_AHEAD) {
      const scale = SCALES[mode];
      // A chord every eight beats; the pluck figure walks the triad in between.
      if (step % 8 === 0) { chordIndex++; voice(); }
      // Gated off the world parameters rather than off the gain's current value: reading
      // an AudioParam mid-ramp answers "how far has the fade got", not "should this play".
      if (world.hope > 0.3 && world.tension < 0.5) {
        const degree = PROGRESSION[chordIndex % PROGRESSION.length];
        const note = scale[(degree + [0, 2, 4, 2][step % 4]) % 7];
        if (step % 2 === 0) pluck(nextNoteAt, note);
      }
      nextNoteAt += beat;
      step++;
    }
  }

  return {
    /** Starts on the first gesture, like every other voice in this game. */
    start() {
      if (timer || reduceMotion) return;
      if (!audio.context) return;             // ambience has not woken yet; caller retries
      if (!build()) return;
      if (window.PoAmbientMusic?.isPlaying?.()) {
        // Stopped, not ducked — and remembered, so leaving the game hands it back.
        try { window.PoAmbientMusic.stop(); stoppedAppMusic = true; } catch { /* ignore */ }
      }
      voice();
      timer = setInterval(tick, LOOKAHEAD_MS);
    },

    /**
     * @param {{alive:number, births:number, deaths:number, extinct:number,
     *          eventPressure:number, dayFraction:number}} s rates are per stats interval,
     *   already differenced by the caller — this module never sees cumulative counters.
     */
    setWorld(s) {
      if (!s) return;
      world.alive = s.alive ?? world.alive;
      // Tension: deaths outrunning births, plus whatever the island is currently doing to
      // itself. Extinctions are permanent and weigh accordingly.
      const net = (s.deaths ?? 0) - (s.births ?? 0);
      target.tension = Math.max(0, Math.min(1,
        Math.max(0, net) * 0.16 + (s.eventPressure ?? 0) * 0.55 + Math.min(0.35, (s.extinct ?? 0) * 0.18)));
      // Hope: births, scaled by how populous the island is — six births among twenty
      // creatures is a boom, six among four hundred is a Tuesday.
      const births = s.births ?? 0;
      target.hope = Math.max(0, Math.min(1, 0.22 + births * 0.14 - Math.max(0, net) * 0.10));
      target.night = Math.max(0, Math.min(1, 1 - Math.max(0, Math.sin(((s.dayFraction ?? 0.5) - 0.25) * Math.PI * 2))));
    },

    setEnabled(on) { enabled = !!on; if (ctx && bus) bus.gain.setTargetAtTime(enabled ? 1 : 0, ctx.currentTime, 0.4); },
    get mode() { return mode; },
    get state() { return { ...world, mode, bpm }; },

    dispose() {
      if (timer) { clearInterval(timer); timer = null; }
      try { bus?.disconnect(); } catch { /* context may already be closed */ }
      // Hand the app's soundtrack back exactly as it was found.
      if (stoppedAppMusic) {
        stoppedAppMusic = false;
        try { window.PoAmbientMusic?.start?.('default', 0.12); } catch { /* ignore */ }
      }
      ctx = null; bus = null; padOsc.length = 0; droneOsc.length = 0;
    },
  };
}
