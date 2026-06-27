// §5 Native Web Audio feedback — zero-asset micro-cues.
// Generates triangle/sine oscillator bursts at the call site; no MP3/WAV to
// ship. Lazy AudioContext init on first user gesture (mobile autoplay rules).

let _ctx = null;
let _initPromise = null;

async function getCtx() {
    if (_ctx) return _ctx;
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        _ctx = new Ctor();
        if (_ctx.state === 'suspended') {
            try { await _ctx.resume(); } catch { /* swallow — gesture may not have happened yet */ }
        }
        return _ctx;
    })();
    return _initPromise;
}

/**
 * Play a single tone.
 * @param {number} freq  - Frequency in Hz (e.g. 880 = A5)
 * @param {number} ms    - Duration in milliseconds
 * @param {number} gain  - Peak gain (0..1)
 * @param {string} type  - Oscillator type (triangle/sine/square/sawtooth)
 */
export async function playTone(freq, ms, gain, type) {
    try {
        const ctx = await getCtx();
        const t0 = ctx.currentTime;
        const dur = ms / 1000;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = type || 'triangle';
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(gain, t0 + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + dur);
    } catch { /* AudioContext unavailable — fail silently. */ }
}

/**
 * Play a chord (multiple tones fired simultaneously).
 * @param {number[]} freqs
 * @param {number} ms
 * @param {number} gain
 */
export async function playChord(freqs, ms, gain) {
    for (const f of freqs) {
        playTone(f, ms, gain, 'triangle');
    }
}

export function isAudioAvailable() {
    return !!(window.AudioContext || window.webkitAudioContext);
}