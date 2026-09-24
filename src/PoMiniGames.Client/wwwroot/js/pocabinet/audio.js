// pocabinet/audio.js
//
// Web Audio engine for PoCabinet. Zero dependencies, zero assets: every sound is
// synthesized (periodic waves, filtered noise), which keeps wwwroot small and the
// service-worker precache untouched.
//
// Autoplay policy: an AudioContext must be created or resumed inside a user
// gesture. init() is called from the page's "Start race" click (or the first
// gesture, via armAudioOnGesture); every other entry point no-ops until then.
//
// Graph:  voices ─► sfx bus ─► slow-mo lowpass ─► compressor ─► master ─► out
//
//   • player engine — a V8-ish PeriodicWave (firing order on the 8th harmonic of
//     the cam cycle, cross-plane half-orders for the burble) through a load-driven
//     waveshaper and lowpass, plus AM'd exhaust grit and a gear whine. A virtual
//     six-speed gearbox (the physics has none) turns speed into RPM: upshifts dip
//     the note and pop, lifting off at high RPM crackles, and on the grid the
//     throttle revs it in neutral.
//   • rivals — one lighter voice per other car through an HRTF PannerNode placed
//     where the car is drawn, pitch-shifted for Doppler against the camera.
//   • road + wind noise — rises with speed²; a short slapback delay on the engine
//     swells as the car nears a barrier, panned to that side.
//   • squeal, wall scrape, kerb buzz, impacts (optionally positional), rain on the
//     roof, wiper thunks, camera shutters, and the UI pings (countdown, blip,
//     lap chime, fanfare).
//   • slow motion — one control: pulls the master lowpass down and every engine's
//     pitch with it (the photo-finish moment in race.js).
//
// All continuous controls are setTargetAtTime, so per-frame calls never click.

let ctx = null;            // AudioContext, created on first user gesture
let master = null;         // master GainNode (volume / mute / pause duck)
let bus = null;            // everything feeds this
let slowFilter = null;     // slow-mo lowpass
let noiseBuffer = null;    // 2 s of white noise, shared by every noise source
let engineWave = null;     // PeriodicWave shared by player + rival engines
let driveCurve = null;     // WaveShaper curve for the player engine
let engine = null;         // player engine voice
let road = null;           // { roadGain, windGain, windPan }
let squeal = null;         // { gain, band }
let scrape = null;         // { gain }
let kerb = null;           // { osc, gain }
let rain = null;           // { gain }
let wallFx = null;         // { wet, pan }
const rivals = new Map();  // id -> rival voice

let volume = 0.7;
let muted = false;
let suspended = false;     // pause-menu duck (distinct from browser suspend)
let slowAmount = 0;
let lastShutter = 0;
let lastImpact = 0;

// ── Virtual gearbox (render-only; physics.js has no gears) ──────────────────
export const IDLE_RPM = 950;
export const REDLINE = 8200;
const SHIFT_UP = 7700;
const SHIFT_DOWN = 3700;
const GEAR_TOP_KMH = [66, 108, 150, 192, 236, 292];

const player = {
    gear: 1, rpm: IDLE_RPM, load: 0, throttle: 0, lastThrottle: 0,
    lastT: 0, lastCrackle: 0, active: false,
};

/**
 * Speed → gear + RPM with hysteresis. `state.gear` persists between calls.
 * Returns the shift direction this call (+1 up, −1 down, 0 none).
 */
function gearbox(state, kmh, throttle) {
    const rpmIn = g => kmh / GEAR_TOP_KMH[g - 1] * REDLINE;
    const before = state.gear || 1;
    let g = before;
    while (g < 6 && rpmIn(g) > SHIFT_UP) g++;
    while (g > 1 && rpmIn(g) < SHIFT_DOWN && rpmIn(g - 1) < SHIFT_UP - 600) g--;
    state.gear = g;
    let rpm = rpmIn(g);
    // Clutch slip off the line: first gear under ~40 km/h revs with the throttle.
    if (g === 1 && kmh < 40) rpm = Math.max(rpm, IDLE_RPM + throttle * 4200 * (1 - kmh / 40));
    state.rpm = Math.min(REDLINE, Math.max(IDLE_RPM, rpm));
    return g === before ? 0 : (g > before ? 1 : -1);
}

// ── Setup ────────────────────────────────────────────────────────────────────

function makeNoiseBuffer(context) {
    const length = context.sampleRate * 2;
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 0x2f6b1d;
    for (let i = 0; i < length; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        data[i] = (seed / 4294967296) * 2 - 1;
    }
    return buffer;
}

/**
 * The engine timbre. Fundamental = one cam cycle (RPM / 120), so a V8's four
 * firings per crank turn land on harmonic 8. The half-orders (2, 4, 6, 12…) are
 * what a cross-plane crank's uneven firing adds: that is the burble.
 */
function makeEngineWave(context) {
    const N = 64;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);
    const strong = { 1: 0.08, 2: 0.25, 3: 0.12, 4: 0.55, 5: 0.1, 6: 0.3, 7: 0.1, 8: 1.0, 10: 0.3, 12: 0.45, 14: 0.2, 16: 0.6, 20: 0.18, 24: 0.35, 32: 0.25, 40: 0.12, 48: 0.1 };
    let seed = 7;
    for (let n = 1; n < N; n++) {
        seed = (seed * 16807) % 2147483647;
        const sign = (seed & 1) ? 1 : -1;
        const amp = strong[n] ?? 0.15 / Math.pow(n, 1.1);
        imag[n] = amp * sign;
    }
    return context.createPeriodicWave(real, imag);
}

function makeDriveCurve() {
    const n = 1024;
    const curve = new Float32Array(n);
    const k = 2.4;
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) {
        const x = i / (n - 1) * 2 - 1;
        curve[i] = Math.tanh(k * x) / norm;
    }
    return curve;
}

function noiseSource(loop = true) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = loop;
    return src;
}

function filter(type, freq, q = 0.8) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
}

function gainNode(value = 0) {
    const g = ctx.createGain();
    g.gain.value = value;
    return g;
}

function buildPlayerEngine() {
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(engineWave);
    osc.frequency.value = IDLE_RPM / 120;
    const osc2 = ctx.createOscillator();
    osc2.setPeriodicWave(engineWave);
    osc2.frequency.value = IDLE_RPM / 120;
    osc2.detune.value = 11;
    const osc2Gain = gainNode(0.45);

    const pre = gainNode(0.8);
    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve;
    shaper.oversample = '2x';
    const lp = filter('lowpass', 600, 1.1);
    const shift = gainNode(1);       // shift dips
    const out = gainNode(0);         // engine level

    osc.connect(pre);
    osc2.connect(osc2Gain);
    osc2Gain.connect(pre);
    pre.connect(shaper);
    shaper.connect(lp);

    // Exhaust grit: band-passed noise, amplitude-modulated at the firing frequency.
    const grit = noiseSource();
    const gritBand = filter('bandpass', 400, 1.4);
    const gritGain = gainNode(0);
    const am = ctx.createOscillator();
    am.type = 'sine';
    am.frequency.value = IDLE_RPM / 15;
    const amDepth = gainNode(0.03);
    am.connect(amDepth);
    amDepth.connect(gritGain.gain);
    grit.connect(gritBand);
    gritBand.connect(gritGain);
    gritGain.connect(lp);

    lp.connect(shift);
    shift.connect(out);
    out.connect(bus);

    // Gear whine: tracks road speed, not RPM, so it carries on straight through shifts.
    const whine = ctx.createOscillator();
    whine.type = 'sine';
    whine.frequency.value = 200;
    const whineGain = gainNode(0);
    whine.connect(whineGain);
    whineGain.connect(bus);

    // Barrier slapback: a short feedback delay fed from the engine, panned to the wall side.
    const delay = ctx.createDelay(0.2);
    delay.delayTime.value = 0.028;
    const fb = gainNode(0.32);
    const wet = gainNode(0);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    out.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(wet);
    if (pan) { wet.connect(pan); pan.connect(bus); } else wet.connect(bus);
    wallFx = { wet, pan };

    for (const s of [osc, osc2, grit, am, whine]) s.start();
    return { osc, osc2, pre, lp, shift, out, gritGain, am, amDepth, gritBand, whine, whineGain };
}

function buildBeds() {
    // Road rumble + wind: two noise beds, both scale with speed².
    const src = noiseSource();
    const roadLp = filter('lowpass', 420, 0.7);
    const roadGain = gainNode(0);
    const windBand = filter('bandpass', 1100, 0.5);
    const windGain = gainNode(0);
    src.connect(roadLp); roadLp.connect(roadGain); roadGain.connect(bus);
    src.connect(windBand); windBand.connect(windGain); windGain.connect(bus);
    src.start();
    road = { roadGain, windGain, windBand };

    // Tire squeal: noise through a resonant bandpass whose centre wobbles.
    const sq = noiseSource();
    const band = filter('bandpass', 1700, 7);
    const sqGain = gainNode(0);
    sq.connect(band); band.connect(sqGain); sqGain.connect(bus);
    sq.start();
    squeal = { gain: sqGain, band };

    // Wall scrape: bright grinding noise.
    const sc = noiseSource();
    const scBand = filter('bandpass', 2600, 2.5);
    const scGain = gainNode(0);
    sc.connect(scBand); scBand.connect(scGain); scGain.connect(bus);
    sc.start();
    scrape = { gain: scGain };

    // Kerb buzz: a square wave at a speed-dependent rate, low-passed into a rumble.
    const k = ctx.createOscillator();
    k.type = 'square';
    k.frequency.value = 30;
    const kLp = filter('lowpass', 360, 1.5);
    const kGain = gainNode(0);
    k.connect(kLp); kLp.connect(kGain); kGain.connect(bus);
    k.start();
    kerb = { osc: k, gain: kGain };

    // Rain on the roof.
    const r = noiseSource();
    const rHp = filter('highpass', 500, 0.5);
    const rLp = filter('lowpass', 5200, 0.5);
    const rGain = gainNode(0);
    r.connect(rHp); rHp.connect(rLp); rLp.connect(rGain); rGain.connect(bus);
    r.start();
    rain = { gain: rGain };
}

/** Create/resume the AudioContext. Must be called from a user-gesture call path. */
export function init() {
    try {
        if (!ctx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return false;
            ctx = new Ctx();
            noiseBuffer = makeNoiseBuffer(ctx);
            engineWave = makeEngineWave(ctx);
            driveCurve = makeDriveCurve();

            master = gainNode(0);
            applyMasterGain();
            const comp = ctx.createDynamicsCompressor();
            comp.threshold.value = -16;
            comp.knee.value = 12;
            comp.ratio.value = 4;
            comp.attack.value = 0.004;
            comp.release.value = 0.2;
            slowFilter = filter('lowpass', 20000, 0.7);
            bus = gainNode(1);
            bus.connect(slowFilter);
            slowFilter.connect(comp);
            comp.connect(master);
            master.connect(ctx.destination);

            engine = buildPlayerEngine();
            buildBeds();
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

// ── Player engine ────────────────────────────────────────────────────────────

/**
 * Drive the player's engine. Called every render frame.
 *   speedKmh — the player car's speed
 *   throttle — 0..1 pedal (drives load: brightness, drive, level)
 *   phase    — 'race' (follow the car), 'grid' (neutral revs before GO),
 *              'off' (fade out: replay, results, teardown)
 * The gearbox runs even before the AudioContext exists, so the cockpit's gear
 * readout and shift lights work with sound off.
 */
export function updateEngine(speedKmh, throttle = 0, phase = 'race') {
    const kmh = Math.max(0, Number(speedKmh) || 0);
    const thr = Math.min(1, Math.max(0, Number(throttle) || 0));
    const now = ctx ? ctx.currentTime : performance.now() / 1000;
    const dt = player.lastT ? Math.min(0.1, Math.max(0, now - player.lastT)) : 0;
    player.lastT = now;
    player.load += (thr - player.load) * (1 - Math.exp(-dt * 9));
    player.active = phase !== 'off';

    let shifted = 0;
    if (phase === 'grid') {
        player.gear = 1;
        const target = IDLE_RPM + player.load * 6600;
        player.rpm += (target - player.rpm) * (1 - Math.exp(-dt * (target > player.rpm ? 7 : 3)));
    } else {
        shifted = gearbox(player, kmh, thr);
    }

    if (!ctx || !engine) { player.lastThrottle = thr; return; }
    const t = ctx.currentTime;
    const pitch = 1 - slowAmount * 0.42;
    const rpm = player.rpm;
    const r01 = (rpm - IDLE_RPM) / (REDLINE - IDLE_RPM);
    const load = player.load;
    const base = rpm / 120 * pitch;
    const tc = shifted ? 0.03 : 0.05;
    engine.osc.frequency.setTargetAtTime(base, t, tc);
    engine.osc2.frequency.setTargetAtTime(base, t, tc);
    engine.am.frequency.setTargetAtTime(rpm / 15 * pitch, t, tc);
    engine.gritBand.frequency.setTargetAtTime(rpm / 15 * 2.2 * pitch, t, 0.06);
    engine.lp.frequency.setTargetAtTime(320 + rpm * 0.22 + load * rpm * 0.34, t, 0.06);
    engine.pre.gain.setTargetAtTime(0.55 + load * 1.3, t, 0.06);
    engine.amDepth.gain.setTargetAtTime(0.02 + load * 0.07, t, 0.08);
    const level = player.active ? (0.09 + r01 * 0.06) * (0.55 + load * 0.45) : 0;
    engine.out.gain.setTargetAtTime(level, t, player.active ? 0.08 : 0.25);

    const s01 = Math.min(1, kmh / 280);
    engine.whine.frequency.setTargetAtTime((180 + s01 * 1100) * pitch, t, 0.08);
    engine.whineGain.gain.setTargetAtTime(player.active && phase === 'race' ? s01 * 0.012 * (0.4 + load) : 0, t, 0.1);
    road.roadGain.gain.setTargetAtTime(player.active && phase === 'race' ? s01 * s01 * 0.09 : 0, t, 0.12);
    road.windGain.gain.setTargetAtTime(player.active && phase === 'race' ? s01 * s01 * 0.05 : 0, t, 0.12);
    road.windBand.frequency.setTargetAtTime(700 + s01 * 1400, t, 0.2);

    if (shifted > 0 && player.active) {
        engine.shift.gain.cancelScheduledValues(t);
        engine.shift.gain.setValueAtTime(1, t);
        engine.shift.gain.linearRampToValueAtTime(0.3, t + 0.04);
        engine.shift.gain.linearRampToValueAtTime(1, t + 0.14);
        crackle(2, 0.06, 0.7);
    }
    // Lift-off overrun: throttle snapped shut at high RPM → exhaust crackle.
    if (player.active && phase === 'race' && player.lastThrottle > 0.55 && thr < 0.1 && rpm > 4800
        && t - player.lastCrackle > 0.8) {
        player.lastCrackle = t;
        crackle(4 + Math.floor(Math.random() * 5), 0.55, 1);
    }
    player.lastThrottle = thr;
}

/** Gear, RPM and redline for the cockpit readout. */
export function engineState() {
    return { gear: player.gear, rpm: player.rpm, redline: REDLINE, idle: IDLE_RPM };
}

/** A burst of short exhaust pops spread over `spread` seconds. */
function crackle(count, spread, strength) {
    if (!ctx) return;
    const t0 = ctx.currentTime;
    for (let i = 0; i < count; i++) {
        const t = t0 + Math.random() * spread;
        const dur = 0.012 + Math.random() * 0.025;
        const src = noiseSource(false);
        const band = filter('bandpass', 700 + Math.random() * 2000, 0.9);
        const g = gainNode(0);
        const peak = (0.12 + Math.random() * 0.2) * strength;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(peak, t + 0.002);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        src.connect(band); band.connect(g); g.connect(bus);
        src.start(t, Math.random() * 1.5, dur + 0.02);
        if (Math.random() < 0.35) sweep(95, 55, 0.05, 'sine', peak * 0.8, t);
    }
}

/** One oscillator sweep with an exponential decay — thumps, pops, chirps. */
function sweep(f0, f1, dur, type, peak, at, dest) {
    if (!ctx) return;
    const t = at ?? ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = gainNode(0);
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(dest || bus);
    o.start(t);
    o.stop(t + dur + 0.03);
}

/** A noise burst through a filter. */
function burst(type, freq, q, dur, peak, at, dest) {
    if (!ctx) return;
    const t = at ?? ctx.currentTime;
    const src = noiseSource(false);
    const f = filter(type, freq, q);
    const g = gainNode(0);
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(dest || bus);
    src.start(t, Math.random() * 1.5, dur + 0.03);
}

// ── Continuous effects ───────────────────────────────────────────────────────

/** Tire squeal. `amount` 0..1 (true = 1); pitch rises with speed. */
export function setSqueal(amount, speedKmh = 150) {
    if (!ctx || !squeal) return;
    const a = amount === true ? 1 : Math.min(1, Math.max(0, Number(amount) || 0));
    const t = ctx.currentTime;
    squeal.gain.gain.setTargetAtTime(a * 0.07, t, 0.06);
    const s01 = Math.min(1, (Number(speedKmh) || 0) / 280);
    squeal.band.frequency.setTargetAtTime((1350 + s01 * 700 + Math.sin(t * 23) * 90) * (1 - slowAmount * 0.4), t, 0.05);
}

/** Metal-on-barrier grind while the car rides the wall. */
export function setScrape(amount) {
    if (!ctx || !scrape) return;
    scrape.gain.gain.setTargetAtTime(Math.min(1, Math.max(0, amount)) * 0.06, ctx.currentTime, 0.05);
}

/** Kerb buzz. The rate follows speed, as stripes pass under the tyres faster. */
export function setKerb(on, speedKmh) {
    if (!ctx || !kerb) return;
    const t = ctx.currentTime;
    kerb.osc.frequency.setTargetAtTime((22 + (Number(speedKmh) || 0) * 0.18) * (1 - slowAmount * 0.4), t, 0.03);
    kerb.gain.gain.setTargetAtTime(on ? 0.1 : 0, t, on ? 0.015 : 0.05);
}

/** Barrier proximity: 0..1 slapback, panned to `side` (−1 left … +1 right). */
export function setWallProximity(amount, side) {
    if (!ctx || !wallFx) return;
    const t = ctx.currentTime;
    const a = Math.min(1, Math.max(0, Number(amount) || 0));
    wallFx.wet.gain.setTargetAtTime(a * 0.55, t, 0.08);
    if (wallFx.pan) wallFx.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, Number(side) || 0)) * 0.8, t, 0.1);
}

/** Rain on the roof, 0..1. */
export function setRain(level) {
    if (!ctx || !rain) return;
    rain.gain.gain.setTargetAtTime(Math.min(1, Math.max(0, Number(level) || 0)) * 0.035, ctx.currentTime, 0.6);
}

/** Slow motion 0..1: lowpass the whole mix and drop every engine's pitch. */
export function setSlowMo(amount) {
    slowAmount = Math.min(1, Math.max(0, Number(amount) || 0));
    if (!ctx || !slowFilter) return;
    const cutoff = 20000 * Math.pow(650 / 20000, slowAmount);
    slowFilter.frequency.setTargetAtTime(cutoff, ctx.currentTime, 0.08);
}

/** Silence everything race-owned (engine, beds, rivals). Rain belongs to the environment. */
export function silenceRace() {
    updateEngine(0, 0, 'off');
    setSqueal(0);
    setScrape(0);
    setKerb(false, 0);
    setWallProximity(0, 0);
    setSlowMo(0);
    updateRivals([]);
}

// ── Rivals: positional engines with Doppler ──────────────────────────────────

const SOUND_SPEED = 60;          // world units/s: tuned so a pass-by bends, not warbles
const listenerPos = { x: 0, y: 0, z: 0 };
const listenerVel = { x: 0, y: 0, z: 0 };

function makePanner() {
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 3;
    p.rolloffFactor = 1.1;
    p.maxDistance = 400;
    return p;
}

function setPannerPosition(p, x, y, z) {
    const t = ctx.currentTime;
    if (p.positionX) {
        p.positionX.setTargetAtTime(x, t, 0.02);
        p.positionY.setTargetAtTime(y, t, 0.02);
        p.positionZ.setTargetAtTime(z, t, 0.02);
    } else {
        p.setPosition(x, y, z);
    }
}

/**
 * Place the listener (the camera). pos/fwd/up are {x,y,z}; vel is the camera's
 * velocity in world units/s (drives Doppler).
 */
export function updateListener(pos, fwd, up, vel) {
    if (pos) { listenerPos.x = pos.x; listenerPos.y = pos.y; listenerPos.z = pos.z; }
    if (vel) { listenerVel.x = vel.x; listenerVel.y = vel.y; listenerVel.z = vel.z; }
    if (!ctx || !pos || !fwd) return;
    const l = ctx.listener;
    const t = ctx.currentTime;
    const u = up || { x: 0, y: 1, z: 0 };
    try {
        if (l.positionX) {
            l.positionX.setTargetAtTime(pos.x, t, 0.02);
            l.positionY.setTargetAtTime(pos.y, t, 0.02);
            l.positionZ.setTargetAtTime(pos.z, t, 0.02);
            l.forwardX.setTargetAtTime(fwd.x, t, 0.02);
            l.forwardY.setTargetAtTime(fwd.y, t, 0.02);
            l.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
            l.upX.setTargetAtTime(u.x, t, 0.02);
            l.upY.setTargetAtTime(u.y, t, 0.02);
            l.upZ.setTargetAtTime(u.z, t, 0.02);
        } else {
            l.setPosition(pos.x, pos.y, pos.z);
            l.setOrientation(fwd.x, fwd.y, fwd.z, u.x, u.y, u.z);
        }
    } catch { /* listener is best-effort */ }
}

function makeRivalVoice() {
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(engineWave);
    osc.frequency.value = IDLE_RPM / 120;
    const lp = filter('lowpass', 900, 0.9);
    const g = gainNode(0);
    const panner = makePanner();
    osc.connect(lp); lp.connect(g); g.connect(panner); panner.connect(bus);
    osc.start();
    return { osc, lp, g, panner, state: { gear: 1, rpm: IDLE_RPM }, lastKmh: 0, seen: 0 };
}

function dropRival(id, v) {
    try {
        const t = ctx.currentTime;
        v.g.gain.setTargetAtTime(0, t, 0.05);
        v.osc.stop(t + 0.3);
        window.setTimeout(() => { try { v.panner.disconnect(); } catch { /* gone */ } }, 400);
    } catch { /* already stopped */ }
    rivals.delete(id);
}

/**
 * Every other car's engine, in world units: [{ id, x, y, z, vx, vz, kmh }].
 * Cars missing from the list fade out and are released.
 */
export function updateRivals(list) {
    if (!ctx) return;
    const stamp = performance.now();
    const t = ctx.currentTime;
    for (const r of list || []) {
        let v = rivals.get(r.id);
        if (!v) { v = makeRivalVoice(); rivals.set(r.id, v); }
        v.seen = stamp;
        const kmh = Math.max(0, Number(r.kmh) || 0);
        const accel = kmh - v.lastKmh;
        v.lastKmh = kmh;
        gearbox(v.state, kmh, accel > 0 ? 1 : 0);

        const dx = r.x - listenerPos.x, dy = (r.y || 0) - listenerPos.y, dz = r.z - listenerPos.z;
        const d = Math.hypot(dx, dy, dz) || 1;
        const nx = dx / d, ny = dy / d, nz = dz / d;
        const vs = (r.vx || 0) * nx + (r.vz || 0) * nz;
        const vl = listenerVel.x * nx + listenerVel.y * ny + listenerVel.z * nz;
        const doppler = Math.min(1.5, Math.max(0.65, (SOUND_SPEED + vl) / (SOUND_SPEED + vs)));

        const pitch = doppler * (1 - slowAmount * 0.42);
        v.osc.frequency.setTargetAtTime(v.state.rpm / 120 * pitch, t, 0.05);
        const r01 = (v.state.rpm - IDLE_RPM) / (REDLINE - IDLE_RPM);
        v.lp.frequency.setTargetAtTime(500 + v.state.rpm * 0.35, t, 0.08);
        v.g.gain.setTargetAtTime(0.16 + r01 * 0.14, t, 0.1);
        setPannerPosition(v.panner, r.x, r.y || 0.5, r.z);
    }
    for (const [id, v] of rivals) if (v.seen !== stamp) dropRival(id, v);
}

// ── One-shots ────────────────────────────────────────────────────────────────

/** Route a one-shot through a temporary panner when it has a world position. */
function oneShotDest(pos) {
    if (!pos) return null;
    const p = makePanner();
    setPannerPosition(p, pos.x, pos.y ?? 0.5, pos.z);
    p.connect(bus);
    window.setTimeout(() => { try { p.disconnect(); } catch { /* gone */ } }, 1500);
    return p;
}

/**
 * A crash: low thump + crunch + metallic ring. kind 'wall' | 'car'.
 * `pos` (world units) makes it positional — a rival's shunt heard from where it happened.
 */
export function impact(strength, kind = 'wall', pos = null) {
    if (!ctx) return;
    const t = ctx.currentTime;
    if (t - lastImpact < 0.09) return;
    lastImpact = t;
    const s = Math.min(1, Math.max(0.1, Number(strength) || 0));
    const dest = oneShotDest(pos);
    const car = kind === 'car';
    sweep(car ? 170 : 115, car ? 70 : 42, 0.2, 'sine', 0.3 * s, t, dest);
    burst('lowpass', car ? 2400 : 1600, 0.7, 0.14, 0.28 * s, t, dest);
    burst('bandpass', car ? 3200 : 2300, 6, car ? 0.12 : 0.08, 0.12 * s, t + 0.01, dest);
    if (car) sweep(2100, 1900, 0.18, 'triangle', 0.02 * s, t + 0.01, dest);
}

/** Press-camera shutter: two clicks and a faint flash-charge whine. Rate-limited. */
export function shutter(pos = null, strength = 1) {
    if (!ctx) return;
    const t = ctx.currentTime;
    if (t - lastShutter < 0.07) return;
    lastShutter = t;
    const dest = oneShotDest(pos);
    const s = Math.min(1, Math.max(0.2, strength));
    burst('highpass', 2600, 0.7, 0.012, 0.22 * s, t, dest);
    burst('highpass', 3400, 0.7, 0.01, 0.16 * s, t + 0.055, dest);
    sweep(2400, 5600, 0.22, 'sine', 0.012 * s, t + 0.02, dest);
}

/** Wiper blade reaching the end of its sweep. */
export function wiper() {
    if (!ctx) return;
    const t = ctx.currentTime;
    sweep(85, 60, 0.07, 'sine', 0.07, t);
    if (Math.random() < 0.5) sweep(980, 760, 0.1, 'triangle', 0.012, t + 0.01);
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
        g.connect(bus);
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
