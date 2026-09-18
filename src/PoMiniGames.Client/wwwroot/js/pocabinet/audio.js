// pocabinet/audio.js
//
// Web Audio engine for PoCabinet — the first audio the game has ever had.
// Zero dependencies, zero assets: every sound is synthesized (oscillators +
// filtered noise), which keeps wwwroot small and the service-worker precache
// untouched.
//
// Autoplay policy: an AudioContext must be created or resumed inside a user
// gesture. init() is called from the page's "Start race" click; every other
// entry point no-ops safely until then.
//
// Sounds:
//   • engine hum — two detuned oscillators through a lowpass; pitch + gain
//     track player speed (updateEngine per snapshot)
//   • tire squeal — looping noise through a bandpass, gain-ramped on hard
//     steering at speed (setSqueal)
//   • countdown beeps / GO — short sine pings, final ping higher + longer
//   • dialogue blip — radio-click double square blip before a bark renders
//   • lap chime / finish fanfare — tiny arpeggios
//
// All state transitions are idempotent so 30 Hz snapshot calls are cheap.

let ctx = null;            // AudioContext, created on first user gesture
let master = null;         // master GainNode
let engine = null;         // { osc1, osc2, filter, gain }
let squeal = null;         // { src, gain }
let volume = 0.7;
let muted = false;
let suspended = false;     // pause-menu duck (distinct from browser suspend)
let engineTarget = { freq: 40, gain: 0 };

function makeNoiseBuffer(context) {
    const length = context.sampleRate * 1; // 1 s of white noise, looped
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
}

/** Create/resume the AudioContext. Must be called from a user-gesture call path. */
export function init() {
    try {
        if (!ctx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return false;
            ctx = new Ctx();
            master = ctx.createGain();
            applyMasterGain();
            master.connect(ctx.destination);

            // ── Engine hum: saw + square sub, lowpass, quiet ──
            const osc1 = ctx.createOscillator();
            osc1.type = 'sawtooth';
            osc1.frequency.value = engineTarget.freq;
            const osc2 = ctx.createOscillator();
            osc2.type = 'square';
            osc2.frequency.value = engineTarget.freq / 2;
            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 320;
            filter.Q.value = 0.8;
            const gain = ctx.createGain();
            gain.gain.value = 0;
            osc1.connect(filter);
            osc2.connect(filter);
            filter.connect(gain);
            gain.connect(master);
            osc1.start();
            osc2.start();
            engine = { osc1, osc2, filter, gain };

            // ── Tire squeal: looped noise through a bandpass ──
            const src = ctx.createBufferSource();
            src.buffer = makeNoiseBuffer(ctx);
            src.loop = true;
            const band = ctx.createBiquadFilter();
            band.type = 'bandpass';
            band.frequency.value = 1700;
            band.Q.value = 6;
            const sGain = ctx.createGain();
            sGain.gain.value = 0;
            src.connect(band);
            band.connect(sGain);
            sGain.connect(master);
            src.start();
            squeal = { src, gain: sGain };
        }
        if (ctx.state === 'suspended') void ctx.resume();
        return true;
    } catch {
        return false;
    }
}

function applyMasterGain() {
    if (!master) return;
    const target = (muted || suspended) ? 0 : volume;
    master.gain.setTargetAtTime(target, ctx.currentTime, 0.05);
}

/** Merge persisted audio prefs (called from settings apply). */
export function setVolume(v) {
    const n = Number(v);
    if (Number.isFinite(n)) volume = Math.min(1, Math.max(0, n));
    if (ctx) applyMasterGain();
}

export function setMuted(m) {
    muted = !!m;
    if (ctx) applyMasterGain();
}

/** Pause-menu duck: true = silence everything without tearing down nodes. */
export function setSuspended(s) {
    suspended = !!s;
    if (ctx) applyMasterGain();
}

/**
 * Drive the engine hum from the player's speed (km/h). Called per snapshot —
 * internally a setTargetAtTime, so 30 Hz calls cost nothing and never click.
 */
export function updateEngine(speedKmh) {
    if (!ctx || !engine) return;
    const t = Math.min(1, Math.max(0, (speedKmh || 0) / 260));
    engineTarget = {
        freq: 42 + t * 150,
        gain: speedKmh > 0.5 ? 0.05 + t * 0.10 : 0.03,
    };
    const now = ctx.currentTime;
    engine.osc1.frequency.setTargetAtTime(engineTarget.freq, now, 0.08);
    engine.osc2.frequency.setTargetAtTime(engineTarget.freq / 2, now, 0.08);
    engine.filter.frequency.setTargetAtTime(280 + t * 900, now, 0.1);
    engine.gain.gain.setTargetAtTime(engineTarget.gain, now, 0.1);
}

/** Tire squeal on/off (hard steering at speed). Ramped to avoid clicks. */
export function setSqueal(active) {
    if (!ctx || !squeal) return;
    squeal.gain.gain.setTargetAtTime(active ? 0.08 : 0, ctx.currentTime, 0.06);
}

/** One synthesized ping. */
export function beep(freq, durationSeconds, type = 'sine', gainValue = 0.15) {
    if (!ctx) return;
    try {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = freq;
        const g = ctx.createGain();
        g.gain.setValueAtTime(gainValue, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationSeconds);
        osc.connect(g);
        g.connect(master);
        osc.start();
        osc.stop(ctx.currentTime + durationSeconds + 0.02);
    } catch { /* never let audio kill the race */ }
}

/** Countdown: 3 short pings then a raised GO ping. */
export function countdownBeep(isFinal) {
    beep(isFinal ? 990 : 620, isFinal ? 0.5 : 0.14, 'sine', 0.18);
}

/** Radio blip before an official speaks. */
export function blip() {
    beep(1320, 0.05, 'square', 0.06);
    if (ctx) {
        try {
            window.setTimeout(() => beep(990, 0.05, 'square', 0.05), 70);
        } catch { /* noop */ }
    }
}

/** Lap completed: two-note chime. */
export function lapChime() {
    beep(660, 0.1, 'triangle', 0.12);
    if (ctx) {
        try { window.setTimeout(() => beep(880, 0.14, 'triangle', 0.12), 110); } catch { /* noop */ }
    }
}

/** Race finished: short arpeggio, brighter for a podium finish. */
export function fanfare(podium) {
    const notes = podium ? [523, 659, 784, 1047] : [523, 494, 440];
    notes.forEach((f, i) => {
        try {
            window.setTimeout(() => beep(f, 0.22, 'triangle', 0.13), i * 130);
        } catch { /* noop */ }
    });
}
