// ambientMusic.js — generative background beds. Zero bytes of audio ship.
//
// Every other music system on the web downloads a loop. This one synthesises
// one: a small pool of detuned oscillators through a lowpass whose cutoff is
// walked by an LFO, plus an occasional plucked note drawn from a scale. The
// result never repeats exactly, costs nothing to download, and can be steered
// at runtime by game state (see setIntensity).
//
// It rides the shared 'music' bus from audioBus.js, so:
//   - global mute silences it,
//   - duck() dips it under foreground cues automatically,
//   - the analyser meters it for the audio-reactive visuals in audioReactive.js.
//
// CPU: ~6 always-on oscillators plus short-lived pluck voices. Negligible next
// to the WASM runtime, and all of it runs on the audio thread, not the main one.

import * as AudioBus from './audioBus.js';

// Scales as semitone offsets from the root. Each bed picks one; the character
// difference between them is most of what makes the games sound distinct.
const SCALES = {
    minorPentatonic: [0, 3, 5, 7, 10],
    lydian: [0, 2, 4, 6, 7, 9, 11],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    wholeTone: [0, 2, 4, 6, 8, 10],
};

// Per-game presets. Add a key here to give a game its own bed.
const PRESETS = {
    posurvive: { root: 55.00, scale: 'minorPentatonic', cutoff: 520, drift: 0.045, pluck: 0.55, wave: 'sawtooth', reverb: 0.30 },
    pojoker:   { root: 65.41, scale: 'dorian',          cutoff: 760, drift: 0.070, pluck: 0.85, wave: 'triangle', reverb: 0.22 },
    poracer:   { root: 73.42, scale: 'wholeTone',       cutoff: 900, drift: 0.110, pluck: 0.25, wave: 'sawtooth', reverb: 0.15 },
    marblerace:{ root: 49.00, scale: 'lydian',          cutoff: 640, drift: 0.050, pluck: 0.65, wave: 'triangle', reverb: 0.35 },
    default:   { root: 58.27, scale: 'lydian',          cutoff: 680, drift: 0.055, pluck: 0.45, wave: 'triangle', reverb: 0.25 },
};

let _state = null;   // active bed
let _timer = null;   // pluck scheduler

function midiRatio(semitones) {
    return Math.pow(2, semitones / 12);
}

/**
 * Start (or switch to) a bed.
 * @param {string} presetName key of PRESETS, e.g. 'posurvive'
 * @param {number} [gain=0.14] bed level on the music bus (kept low on purpose)
 */
export async function start(presetName, gain) {
    const ctx = await AudioBus.context();
    const musicBus = await AudioBus.bus('music');
    if (!ctx || !musicBus) return false;

    // Switching beds crossfades rather than cutting.
    if (_state) await stop(1.2);

    const preset = PRESETS[presetName] || PRESETS.default;
    const scale = SCALES[preset.scale] || SCALES.lydian;
    const level = gain == null ? 0.14 : gain;
    const t0 = ctx.currentTime;

    const bedGain = ctx.createGain();
    bedGain.gain.setValueAtTime(0, t0);
    bedGain.gain.linearRampToValueAtTime(level, t0 + 3.0); // slow fade-in, never a jump

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = preset.cutoff;
    filter.Q.value = 1.4;

    filter.connect(bedGain).connect(musicBus);

    // ── Drone: three voices, slightly detuned so they beat against each other.
    // Perfect unison would sound synthetic and dead; a few cents of spread is
    // what reads as "warm".
    const voices = [];
    const detunes = [-7, 0, 5];
    for (let i = 0; i < detunes.length; i++) {
        const osc = ctx.createOscillator();
        osc.type = preset.wave;
        osc.frequency.value = preset.root * (i === 2 ? 2 : 1); // one voice an octave up
        osc.detune.value = detunes[i];
        const vg = ctx.createGain();
        vg.gain.value = i === 2 ? 0.28 : 0.5;
        osc.connect(vg).connect(filter);
        osc.start(t0);
        voices.push(osc);
    }

    // ── Cutoff LFO: the whole reason this doesn't sound static. A slow sine on
    // the filter frequency makes the pad "breathe".
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = preset.drift;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = preset.cutoff * 0.55;
    lfo.connect(lfoDepth).connect(filter.frequency);
    lfo.start(t0);

    await AudioBus.setReverb(preset.reverb);

    _state = { ctx, preset, scale, voices, lfo, lfoDepth, filter, bedGain, level, intensity: 0.5 };
    schedulePluck();
    return true;
}

/**
 * Occasional single notes over the drone, at irregular intervals so the ear
 * never locks onto a loop. Interval and register both scale with intensity.
 */
function schedulePluck() {
    if (!_state) return;
    const { preset } = _state;
    const base = 2600 - _state.intensity * 1500;         // busier when intense
    const wait = base + Math.random() * base * 0.8;
    _timer = setTimeout(() => {
        pluck();
        schedulePluck();
    }, wait);
}

function pluck() {
    if (!_state || AudioBus.isMuted()) return;
    const { ctx, preset, scale, filter, intensity } = _state;
    if (Math.random() > preset.pluck) return;

    const t0 = ctx.currentTime;
    const octave = 2 + Math.floor(Math.random() * 2) + (intensity > 0.7 ? 1 : 0);
    const degree = scale[Math.floor(Math.random() * scale.length)];
    const freq = preset.root * Math.pow(2, octave) * midiRatio(degree);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;

    const g = ctx.createGain();
    const dur = 1.6 + Math.random() * 1.8;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.16, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    // Plucks are panned randomly across the field so the bed feels wide.
    if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = (Math.random() * 2 - 1) * 0.7;
        osc.connect(g).connect(p).connect(filter);
    } else {
        osc.connect(g).connect(filter);
    }
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
}

/**
 * Steer the bed from game state. PoSurvive drives this from agents-remaining,
 * so the music tightens as the battle thins out.
 * @param {number} value 0 (calm) .. 1 (tense)
 */
export async function setIntensity(value) {
    if (!_state) return;
    const v = Math.max(0, Math.min(1, value));
    _state.intensity = v;
    const { ctx, preset, filter, lfoDepth } = _state;
    const t = ctx.currentTime;
    // Open the filter and widen the sweep as things get tense.
    filter.frequency.setTargetAtTime(preset.cutoff * (1 + v * 1.6), t, 1.5);
    lfoDepth.gain.setTargetAtTime(preset.cutoff * (0.55 + v * 0.5), t, 1.5);
}

/**
 * Fade out and tear down. Always call on page teardown — an orphaned oscillator
 * keeps the audio thread alive for the life of the tab.
 * @param {number} [fadeSec=1.5]
 */
export async function stop(fadeSec) {
    if (!_state) return;
    const { ctx, voices, lfo, bedGain } = _state;
    const s = _state;
    _state = null;
    if (_timer) { clearTimeout(_timer); _timer = null; }

    const t = ctx.currentTime;
    const fade = fadeSec == null ? 1.5 : fadeSec;
    try {
        bedGain.gain.cancelScheduledValues(t);
        bedGain.gain.setValueAtTime(bedGain.gain.value, t);
        bedGain.gain.linearRampToValueAtTime(0.0001, t + fade);
    } catch { /* node may already be gone */ }

    setTimeout(() => {
        try { for (const v of voices) v.stop(); } catch { /* already stopped */ }
        try { lfo.stop(); } catch { /* already stopped */ }
        try { s.filter.disconnect(); s.bedGain.disconnect(); } catch { /* already detached */ }
    }, (fade + 0.1) * 1000);
}

export function isPlaying() {
    return !!_state;
}

if (typeof window !== 'undefined') {
    window.PoAmbientMusic = { start, stop, setIntensity, isPlaying };
}
