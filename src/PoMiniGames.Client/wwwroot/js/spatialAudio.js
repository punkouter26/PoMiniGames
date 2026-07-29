// spatialAudio.js — positional cues on the shared bus.
//
// Two levels of positioning, both riding audioBus.js:
//
//   cueAt(x)      cheap stereo placement via StereoPannerNode. Use for 2D
//                 boards — PoSurvive pans a tactical cue to the acting agent's
//                 grid column, so you hear WHERE something happened before you
//                 find it on screen.
//   cue3D(x,y,z)  full PannerNode with HRTF for the 3D games (MarbleRace,
//                 PoRacer), where a marble pulling ahead on the right should
//                 actually sound like it.
//
// Reverb is shared: audioBus owns one ConvolverNode fed by a synthesized
// impulse response, so a "wet" cue costs no extra convolution and no asset.

import * as AudioBus from './audioBus.js';

/**
 * Fire a positioned tone.
 * @param {object} o
 * @param {number} o.freq      Hz
 * @param {number} [o.ms=180]  duration
 * @param {number} [o.gain=0.2]
 * @param {number} [o.pan=0]   -1 left .. 1 right
 * @param {string} [o.type='triangle']
 * @param {'sfx'|'ui'|'music'} [o.bus='sfx']
 */
export async function cueAt(o) {
    if (AudioBus.isMuted()) return;
    try {
        const ctx = await AudioBus.context();
        const target = await AudioBus.bus(o.bus || 'sfx');
        if (!ctx || !target) return;

        const t0 = ctx.currentTime;
        const dur = (o.ms == null ? 180 : o.ms) / 1000;
        const osc = ctx.createOscillator();
        osc.type = o.type || 'triangle';
        osc.frequency.value = o.freq;

        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(o.gain == null ? 0.2 : o.gain, t0 + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

        let tail = g;
        if (ctx.createStereoPanner) {
            const p = ctx.createStereoPanner();
            p.pan.value = Math.max(-1, Math.min(1, o.pan || 0));
            g.connect(p);
            tail = p;
        }
        osc.connect(g);
        tail.connect(target);

        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
    } catch { /* feedback is best-effort */ }
}

/**
 * Map a grid/board column to a stereo position and fire a cue.
 * @param {number} col   0-based column
 * @param {number} cols  total columns
 * @param {object} opts  passed through to cueAt (freq, ms, gain, type)
 */
export async function cueAtColumn(col, cols, opts) {
    const n = Math.max(1, cols);
    // Map to -0.8..0.8 rather than the full field: hard-panned game audio is
    // fatiguing on headphones and vanishes entirely on a mono speaker.
    const pan = ((col + 0.5) / n) * 1.6 - 0.8;
    return cueAt(Object.assign({ pan }, opts));
}

/**
 * Full 3D placement. Falls back to stereo panning where PannerNode is missing.
 * @param {object} o  {freq, ms, gain, type, x, y, z, bus}
 */
export async function cue3D(o) {
    if (AudioBus.isMuted()) return;
    try {
        const ctx = await AudioBus.context();
        const target = await AudioBus.bus(o.bus || 'sfx');
        if (!ctx || !target) return;
        if (!ctx.createPanner) return cueAt(Object.assign({}, o, { pan: o.x || 0 }));

        const t0 = ctx.currentTime;
        const dur = (o.ms == null ? 180 : o.ms) / 1000;

        const panner = ctx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 1;
        panner.maxDistance = 40;
        panner.rolloffFactor = 1.2;
        if (panner.positionX) {
            panner.positionX.value = o.x || 0;
            panner.positionY.value = o.y || 0;
            panner.positionZ.value = o.z || 0;
        } else {
            panner.setPosition(o.x || 0, o.y || 0, o.z || 0);
        }

        const osc = ctx.createOscillator();
        osc.type = o.type || 'sine';
        osc.frequency.value = o.freq;

        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(o.gain == null ? 0.22 : o.gain, t0 + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

        osc.connect(g).connect(panner).connect(target);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
    } catch { /* best-effort */ }
}

/**
 * Move the listener (for 3D games whose camera moves).
 * @param {number} x @param {number} y @param {number} z
 */
export async function setListener(x, y, z) {
    try {
        const ctx = await AudioBus.context();
        if (!ctx || !ctx.listener) return;
        const l = ctx.listener;
        if (l.positionX) {
            l.positionX.value = x; l.positionY.value = y; l.positionZ.value = z;
        } else if (l.setPosition) {
            l.setPosition(x, y, z);
        }
    } catch { /* best-effort */ }
}

/** Global wet level. Proxy to the bus so callers need only one import. */
export async function setReverb(amount) {
    return AudioBus.setReverb(amount);
}

if (typeof window !== 'undefined') {
    window.PoSpatialAudio = { cueAt, cueAtColumn, cue3D, setListener, setReverb };
}
