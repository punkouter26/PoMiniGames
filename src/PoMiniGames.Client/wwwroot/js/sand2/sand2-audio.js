// ===========================================================================
// Project Sub-Surface — procedural audio engine (Web Audio, zero assets).
// Everything is synthesized at runtime: noise buffers, a procedural cavern
// impulse response for the convolution reverb, continuous ambient beds
// (pour / flow / mist / wind / drone / fuse hiss / seismic rumble) and
// one-shot SFX (blasts, snaps, splashes, thuds, drips). The simulation
// engine drives it with discrete events plus a per-frame stats bundle.
//
// The AudioContext is created lazily on the first user gesture (autoplay
// policy); every entry point no-ops safely before that.
// ===========================================================================

let ctx = null;
let master, limiter, dryBus, verbBus;
let noiseBuf = null, brownBuf = null;
let clipCurve = null;
let beds = null;
let muted = false, volume = 0.7;
let lastLand = 0, lastPlip = 0, lastSnap = 0, lastThud = 0;

export function unlock() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    try { build(); } catch { ctx = null; }
}
export function setMuted(m) { muted = !!m; applyMaster(); }
export function setVolume(v) { volume = Math.max(0, Math.min(1, v)); applyMaster(); }
export function dispose() {
    if (ctx) { try { ctx.close(); } catch { /* already closed */ } }
    ctx = null; beds = null;
}

function applyMaster() {
    if (ctx && master) master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.06);
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

function mkNoise(seconds, brown) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    if (brown) {
        let acc = 0;
        for (let i = 0; i < n; i++) {
            acc = (acc + (Math.random() * 2 - 1) * 0.02) * 0.998;
            d[i] = acc * 18;
        }
    } else {
        for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    return buf;
}

function mkIR(seconds, decay) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < n; i++) {
            const t = i / n;
            d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * Math.exp(-t * 2.2);
        }
    }
    return buf;
}

function build() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 8;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.24;
    limiter.connect(ctx.destination);

    master = ctx.createGain();
    master.gain.value = muted ? 0 : volume;
    master.connect(limiter);

    dryBus = ctx.createGain();
    dryBus.connect(master);

    // Procedural cavern reverb.
    const conv = ctx.createConvolver();
    conv.buffer = mkIR(2.2, 2.6);
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.6;
    conv.connect(verbOut);
    verbOut.connect(master);
    verbBus = ctx.createGain();
    verbBus.connect(conv);

    noiseBuf = mkNoise(2.4, false);
    brownBuf = mkNoise(3.1, true);
    clipCurve = new Float32Array(257);
    for (let i = 0; i < 257; i++) clipCurve[i] = Math.tanh((i / 128 - 1) * 2.5);

    buildBeds();
}

// Route a one-shot voice: entry gain -> optional lowpass -> dry + reverb send.
function route(wet = 0.2, lowpassHz = 0) {
    const inp = ctx.createGain();
    let tail = inp;
    if (lowpassHz > 0) {
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = lowpassHz;
        tail.connect(f);
        tail = f;
    }
    tail.connect(dryBus);
    if (wet > 0.01) {
        const w = ctx.createGain();
        w.gain.value = wet;
        tail.connect(w);
        w.connect(verbBus);
    }
    return inp;
}

function nsrc(buf, loop = false) {
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = loop;
    if (loop) s.loopEnd = buf.duration;
    return s;
}

function env(g, at, attack, peak, dur) {
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
}

// Tiny band-passed noise transient (grain landings, crackle, droplets).
function tick(at, freq, q, peak, dur, dest) {
    const n = nsrc(noiseBuf);
    n.playbackRate.value = 0.5 + Math.random();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    env(g, at, 0.004, peak, dur);
    n.connect(f); f.connect(g); g.connect(dest);
    n.start(at);
    n.stop(at + dur + 0.05);
}

// ---------------------------------------------------------------------------
// Continuous ambient beds
// ---------------------------------------------------------------------------

function mkBed(buf, filterType, freq, q, wet) {
    const src = nsrc(buf, true);
    src.loopStart = Math.random() * buf.duration * 0.5;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f); f.connect(g);
    g.connect(dryBus);
    if (wet > 0.01) {
        const w = ctx.createGain();
        w.gain.value = wet;
        g.connect(w);
        w.connect(verbBus);
    }
    src.start();
    return { src, filter: f, gain: g };
}

function buildBeds() {
    beds = {
        pour: mkBed(noiseBuf, 'bandpass', 1500, 0.8, 0.12),
        flow: mkBed(brownBuf, 'lowpass', 640, 0.7, 0.15),
        mist: mkBed(noiseBuf, 'bandpass', 3200, 1.1, 0.2),
        wind: mkBed(noiseBuf, 'bandpass', 320, 0.6, 0.05),
        fuse: mkBed(noiseBuf, 'highpass', 5200, 0.7, 0.08),
        rumble: mkBed(brownBuf, 'lowpass', 130, 0.8, 0.3),
        vac: mkBed(noiseBuf, 'bandpass', 780, 2.5, 0.05),
    };

    // Wind wanders: a slow LFO wobbles the band centre so it never loops.
    const wlfo = ctx.createOscillator();
    wlfo.frequency.value = 0.07;
    const wg = ctx.createGain();
    wg.gain.value = 130;
    wlfo.connect(wg); wg.connect(beds.wind.filter.frequency);
    wlfo.start();

    // Deep cavern drone: detuned sine pair + faint octave, breathing slowly.
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0;
    droneGain.connect(dryBus);
    const dw = ctx.createGain();
    dw.gain.value = 0.5;
    droneGain.connect(dw); dw.connect(verbBus);
    for (const [fr, g0] of [[54.5, 1.0], [55.3, 0.8], [110.4, 0.3]]) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = fr;
        const og = ctx.createGain();
        og.gain.value = g0;
        o.connect(og); og.connect(droneGain);
        o.start();
    }
    const dlfo = ctx.createOscillator();
    dlfo.frequency.value = 0.045;
    const dlg = ctx.createGain();
    dlg.gain.value = 0.016;
    dlfo.connect(dlg); dlg.connect(droneGain.gain);
    dlfo.start();
    beds.drone = { gain: droneGain };

    // Vacuum motor tone under the dig-tool noise band.
    const vosc = ctx.createOscillator();
    vosc.type = 'sawtooth';
    vosc.frequency.value = 118;
    const vg = ctx.createGain();
    vg.gain.value = 0.3;
    vosc.connect(vg); vg.connect(beds.vac.gain);
    vosc.start();
}

// Per-frame drive from the engine. `s` fields are 0..1 levels (fuse = count).
export function frame(dtMs, s) {
    if (!ctx || !beds || ctx.state !== 'running') return;
    const t = ctx.currentTime, k = 0.18;
    beds.pour.gain.gain.setTargetAtTime(Math.min(0.5, s.pour * 0.85), t, k);
    beds.flow.gain.gain.setTargetAtTime(Math.min(0.5, s.flow * 0.8), t, k);
    beds.mist.gain.gain.setTargetAtTime(Math.min(0.35, s.falls * 0.8), t, k);
    beds.wind.gain.gain.setTargetAtTime(0.025 + 0.05 * s.wind, t, 0.6);
    beds.fuse.gain.gain.setTargetAtTime(Math.min(0.22, s.fuse * 0.1), t, 0.08);
    beds.rumble.gain.gain.setTargetAtTime(Math.min(0.55, s.rumble * 0.5), t, 0.1);
    beds.vac.gain.gain.setTargetAtTime(s.vac ? 0.3 : 0, t, 0.07);
    beds.drone.gain.gain.setTargetAtTime(0.05, t, 1.5);

    // Sparse generative events: cave drips and faint skittering.
    if (Math.random() < dtMs * (0.00012 + 0.0004 * s.flow)) drip();
    if (Math.random() < dtMs * 0.00003) skitter();
}

function drip() {
    const t = ctx.currentTime + Math.random() * 0.05;
    const v = route(0.75);
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f0 = 900 + Math.random() * 900;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.45, t + 0.08);
    const g = ctx.createGain();
    env(g, t, 0.004, 0.1, 0.1);
    o.connect(g); g.connect(v);
    o.start(t);
    o.stop(t + 0.15);
}

function skitter() {
    const t = ctx.currentTime;
    const n = 3 + (Math.random() * 4 | 0);
    for (let i = 0; i < n; i++)
        tick(t + i * 0.028 + Math.random() * 0.012, 4200 + Math.random() * 2800, 3, 0.02, 0.02, route(0.5));
}

// ---------------------------------------------------------------------------
// One-shot SFX
// ---------------------------------------------------------------------------

// TNT detonation: sub-bass drop + soft-clipped crack + brown rumble tail +
// scattered crackle. Underwater blasts are muffled and gurgle; underground
// blasts get a long cavern reverb tail.
export function boom(o = {}) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const depth = o.depth || 0;
    const v = route(0.18 + depth * 0.5, o.submerged ? 340 : 0);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(o.submerged ? 72 : 96, t);
    sub.frequency.exponentialRampToValueAtTime(26, t + 1.35);
    const sg = ctx.createGain();
    env(sg, t, 0.008, 1.0, o.submerged ? 2.3 : 1.7);
    const shaper = ctx.createWaveShaper();
    shaper.curve = clipCurve;
    sub.connect(sg); sg.connect(shaper); shaper.connect(v);
    sub.start(t);
    sub.stop(t + 2.4);

    const crack = nsrc(noiseBuf);
    const cf = ctx.createBiquadFilter();
    cf.type = 'lowpass';
    cf.frequency.setValueAtTime(o.submerged ? 700 : 6800, t);
    cf.frequency.exponentialRampToValueAtTime(140, t + 0.55);
    const cg = ctx.createGain();
    env(cg, t, 0.005, o.submerged ? 0.5 : 0.85, 0.7);
    crack.connect(cf); cf.connect(cg); cg.connect(v);
    crack.start(t);
    crack.stop(t + 0.8);

    const tail = nsrc(brownBuf);
    const tf = ctx.createBiquadFilter();
    tf.type = 'lowpass';
    tf.frequency.value = 190;
    const tg = ctx.createGain();
    env(tg, t + 0.05, 0.08, 0.5, 2.8);
    tail.connect(tf); tf.connect(tg); tg.connect(v);
    tail.start(t);
    tail.stop(t + 3.0);

    if (o.submerged) {
        for (let i = 0; i < 6; i++) {
            const bt = t + 0.15 + Math.random() * 1.2;
            const bo = ctx.createOscillator();
            bo.type = 'sine';
            const bf = 90 + Math.random() * 130;
            bo.frequency.setValueAtTime(bf, bt);
            bo.frequency.exponentialRampToValueAtTime(bf * 3, bt + 0.12);
            const bg = ctx.createGain();
            env(bg, bt, 0.01, 0.08, 0.14);
            bo.connect(bg); bg.connect(v);
            bo.start(bt);
            bo.stop(bt + 0.2);
        }
    } else {
        for (let i = 0; i < 11; i++)
            tick(t + 0.12 + Math.random() * 1.4, 700 + Math.random() * 2600, 2, 0.06 * (1 - i / 14), 0.05, v);
    }
}

// Concrete bar bending failure: dry crack + resonant body knock.
export function snap() {
    if (!ctx) return;
    const t = ctx.currentTime;
    if (t - lastSnap < 0.06) return;
    lastSnap = t;
    const v = route(0.3);
    const n = nsrc(noiseBuf);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 1100;
    const g = ctx.createGain();
    env(g, t, 0.003, 0.55, 0.07);
    n.connect(f); f.connect(g); g.connect(v);
    n.start(t); n.stop(t + 0.12);

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(210, t);
    o.frequency.exponentialRampToValueAtTime(64, t + 0.14);
    const og = ctx.createGain();
    env(og, t, 0.004, 0.5, 0.17);
    o.connect(og); og.connect(v);
    o.start(t); o.stop(t + 0.2);
}

export function shatter() {
    if (!ctx) return;
    snap();
    const t = ctx.currentTime;
    const v = route(0.35);
    for (let i = 0; i < 5; i++)
        tick(t + 0.03 + Math.random() * 0.24, 500 + Math.random() * 1800, 1.5, 0.12, 0.07, v);
}

export function splash(mag = 0.6) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const v = route(0.25);
    const n = nsrc(noiseBuf);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1900, t);
    f.frequency.exponentialRampToValueAtTime(380, t + 0.32);
    const g = ctx.createGain();
    env(g, t, 0.012, 0.5 * mag, 0.4);
    n.connect(f); f.connect(g); g.connect(v);
    n.start(t); n.stop(t + 0.5);

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(260, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.16);
    const og = ctx.createGain();
    env(og, t, 0.01, 0.3 * mag, 0.2);
    o.connect(og); og.connect(v);
    o.start(t); o.stop(t + 0.25);

    for (let i = 0; i < 4; i++)
        tick(t + 0.1 + Math.random() * 0.3, 2600 + Math.random() * 1600, 3, 0.05 * mag, 0.03, v);
}

export function balloonPop() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const v = route(0.2);
    const n = nsrc(noiseBuf);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 900;
    const g = ctx.createGain();
    env(g, t, 0.002, 0.5, 0.04);
    n.connect(f); f.connect(g); g.connect(v);
    n.start(t); n.stop(t + 0.08);
    splash(0.9);
}

// Small droplet entering a pool.
export function plip() {
    if (!ctx) return;
    const t = ctx.currentTime;
    if (t - lastPlip < 0.07) return;
    lastPlip = t;
    const v = route(0.3);
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f0 = 700 + Math.random() * 500;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.4, t + 0.06);
    const g = ctx.createGain();
    env(g, t, 0.004, 0.1, 0.08);
    o.connect(g); g.connect(v);
    o.start(t); o.stop(t + 0.12);
}

export function launch(mag = 0.7) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const v = route(0.1);
    const n = nsrc(noiseBuf);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.6;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(600 + 1900 * mag, t + 0.26);
    const g = ctx.createGain();
    env(g, t, 0.02, 0.22 * (0.4 + mag), 0.3);
    n.connect(f); f.connect(g); g.connect(v);
    n.start(t); n.stop(t + 0.35);
}

// Rigid body hitting the ground.
export function thud(mag = 0.6) {
    if (!ctx) return;
    const t = ctx.currentTime;
    if (t - lastThud < 0.08) return;
    lastThud = t;
    const v = route(0.25);
    const n = nsrc(noiseBuf);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 320;
    const g = ctx.createGain();
    env(g, t, 0.005, 0.45 * mag, 0.13);
    n.connect(f); f.connect(g); g.connect(v);
    n.start(t); n.stop(t + 0.18);

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    const og = ctx.createGain();
    env(og, t, 0.005, 0.55 * mag, 0.15);
    o.connect(og); og.connect(v);
    o.start(t); o.stop(t + 0.2);
}

// Ballistic grain touching down (heavily throttled).
export function grainLand(hot) {
    if (!ctx) return;
    const t = ctx.currentTime;
    if (t - lastLand < 0.045) return;
    lastLand = t;
    tick(t, hot ? 1900 + Math.random() * 1900 : 850 + Math.random() * 800,
        2, hot ? 0.05 : 0.04, 0.025, route(0.15));
}
