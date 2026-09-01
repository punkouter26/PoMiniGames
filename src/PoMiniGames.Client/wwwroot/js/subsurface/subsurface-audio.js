// Procedural audio synthesis for the Sand physics sandbox.
// Zero assets: every sound is synthesized from noise buffers and oscillators
// through a shared master chain (compressor -> master gain), with a generated
// convolution reverb for underground body and per-event stereo panning mapped
// from the blast's x position. The AudioContext is created lazily on the first
// user gesture (autoplay policy) — every public method is safe to call before
// that and simply no-ops.

export class SubSurfaceAudio {
    constructor() {
        this.ctx = null;
        this.enabled = true;
        this.master = null;
        this.reverbSend = null;
        this.windGain = null;
        this.crackleTimer = null;
        this.crackleLevel = 0;
        this.drillNodes = null;
        this.lastBounceAt = 0;
        this.lastSizzleAt = 0;
    }

    // Called from a user-gesture handler; builds the graph once.
    unlock() {
        if (!this.ctx) {
            try {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) return;
                this.ctx = new Ctx();
                this.buildGraph();
            } catch {
                this.ctx = null;
                return;
            }
        }
        if (this.ctx.state === 'suspended') {
            this.ctx.resume().catch(() => {});
        }
    }

    buildGraph() {
        const ctx = this.ctx;
        this.master = ctx.createGain();
        this.master.gain.value = this.enabled ? 0.9 : 0.0;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.knee.value = 24;
        comp.ratio.value = 6;
        this.master.connect(comp);
        comp.connect(ctx.destination);

        // Shared 2s white-noise buffer for every noise-based voice
        const len = ctx.sampleRate * 2;
        this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

        // Generated impulse response: 1.8s decaying noise = cavern reverb
        const irLen = Math.floor(ctx.sampleRate * 1.8);
        const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
            const c = ir.getChannelData(ch);
            for (let i = 0; i < irLen; i++) {
                c[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 2.6);
            }
        }
        const convolver = ctx.createConvolver();
        convolver.buffer = ir;
        this.reverbSend = ctx.createGain();
        this.reverbSend.gain.value = 0.35;
        this.reverbSend.connect(convolver);
        convolver.connect(this.master);

        // Ambient wind bed: looped noise through a slowly wandering lowpass
        const wind = ctx.createBufferSource();
        wind.buffer = this.noise;
        wind.loop = true;
        const windLp = ctx.createBiquadFilter();
        windLp.type = 'lowpass';
        windLp.frequency.value = 320;
        const windLfo = ctx.createOscillator();
        windLfo.frequency.value = 0.11;
        const windLfoGain = ctx.createGain();
        windLfoGain.gain.value = 140;
        windLfo.connect(windLfoGain);
        windLfoGain.connect(windLp.frequency);
        this.windGain = ctx.createGain();
        this.windGain.gain.value = 0.05;
        wind.connect(windLp);
        windLp.connect(this.windGain);
        this.windGain.connect(this.master);
        wind.start();
        windLfo.start();
    }

    setEnabled(on) {
        this.enabled = on;
        if (this.master) {
            this.master.gain.setTargetAtTime(on ? 0.9 : 0.0, this.ctx.currentTime, 0.05);
        }
    }

    panFor(x) {
        // Map world x (0..800) to stereo field, gently narrowed
        return Math.max(-0.8, Math.min(0.8, (x / 800) * 1.6 - 0.8));
    }

    // One noise burst voice: filtered, panned, enveloped, with a reverb send.
    burst({ x = 400, dur = 0.4, gain = 0.5, filterType = 'lowpass', freq = 800,
            freqEnd = 0, q = 0.8, rate = 1.0, reverb = 0.4 }) {
        if (!this.ctx || !this.enabled) return;
        const ctx = this.ctx;
        const t = ctx.currentTime;
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        src.playbackRate.value = rate;
        src.loop = true;
        const f = ctx.createBiquadFilter();
        f.type = filterType;
        f.frequency.setValueAtTime(freq, t);
        if (freqEnd > 0) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
        f.Q.value = q;
        const g = ctx.createGain();
        g.gain.setValueAtTime(gain, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        const pan = ctx.createStereoPanner();
        pan.pan.value = this.panFor(x);
        src.connect(f); f.connect(g); g.connect(pan);
        pan.connect(this.master);
        if (reverb > 0) {
            const send = ctx.createGain();
            send.gain.value = reverb;
            pan.connect(send);
            send.connect(this.reverbSend);
        }
        src.start(t);
        src.stop(t + dur + 0.05);
    }

    // Pitched sine voice (sub-bass drops, thwips)
    tone({ x = 400, dur = 0.3, gain = 0.4, type = 'sine', from = 200, to = 40, reverb = 0.2 }) {
        if (!this.ctx || !this.enabled) return;
        const ctx = this.ctx;
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(from, t);
        o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(gain, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        const pan = ctx.createStereoPanner();
        pan.pan.value = this.panFor(x);
        o.connect(g); g.connect(pan);
        pan.connect(this.master);
        if (reverb > 0) {
            const send = ctx.createGain();
            send.gain.value = reverb;
            pan.connect(send);
            send.connect(this.reverbSend);
        }
        o.start(t);
        o.stop(t + dur + 0.05);
    }

    // yieldScale ~ blast scale (bomblet 0.4 .. nuke 1.45); muffled = underwater/deep
    explosion(x, yieldScale = 1.0, muffled = false) {
        const s = Math.max(0.3, Math.min(2.0, yieldScale));
        // Body: broadband crack collapsing into rumble
        this.burst({
            x, dur: 0.5 + 0.5 * s, gain: 0.55 * s,
            filterType: 'lowpass', freq: muffled ? 320 : 2400 * s, freqEnd: 60,
            reverb: muffled ? 0.7 : 0.45
        });
        // Sub-bass drop sells the size
        this.tone({ x, dur: 0.5 + 0.6 * s, gain: 0.5 * s, from: 110 * s, to: 28, reverb: 0.3 });
        if (s > 1.2 && !muffled) {
            // Big yields get a delayed second rumble
            setTimeout(() => this.burst({
                x, dur: 1.4, gain: 0.3 * s, filterType: 'lowpass', freq: 240, freqEnd: 40, reverb: 0.8
            }), 180);
        }
    }

    launch(power) {
        const p = Math.min(1, power / 600);
        this.tone({ dur: 0.12, gain: 0.16, type: 'triangle', from: 220 + 500 * p, to: 90, reverb: 0.05 });
    }

    balloonPop(x) {
        this.burst({ x, dur: 0.16, gain: 0.4, filterType: 'highpass', freq: 900, q: 0.5, reverb: 0.15 });
        this.splash(x, 0.7);
    }

    splash(x, intensity = 1.0) {
        this.burst({
            x, dur: 0.35 * intensity + 0.15, gain: 0.25 * intensity,
            filterType: 'bandpass', freq: 1400, q: 0.6, rate: 0.7, reverb: 0.2
        });
    }

    bounce(x, speed) {
        const now = performance.now();
        if (now - this.lastBounceAt < 90) return; // rate-limit contact thuds
        this.lastBounceAt = now;
        const s = Math.min(1, speed / 500);
        this.burst({ x, dur: 0.09, gain: 0.14 * s, filterType: 'lowpass', freq: 300 + 300 * s, reverb: 0.1 });
    }

    sizzle(x) {
        const now = performance.now();
        if (now - this.lastSizzleAt < 250) return;
        this.lastSizzleAt = now;
        this.burst({ x, dur: 0.7, gain: 0.2, filterType: 'highpass', freq: 3200, q: 0.4, reverb: 0.25 });
    }

    // Drill grind loop: saw + noise through a wandering bandpass while boring
    drill(on, x = 400) {
        if (!this.ctx || !this.enabled) { return; }
        if (on && !this.drillNodes) {
            const ctx = this.ctx;
            const saw = ctx.createOscillator();
            saw.type = 'sawtooth';
            saw.frequency.value = 55;
            const nz = ctx.createBufferSource();
            nz.buffer = this.noise;
            nz.loop = true;
            const bp = ctx.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.value = 700;
            bp.Q.value = 2.5;
            const wob = ctx.createOscillator();
            wob.frequency.value = 13;
            const wobGain = ctx.createGain();
            wobGain.gain.value = 260;
            wob.connect(wobGain);
            wobGain.connect(bp.frequency);
            const g = ctx.createGain();
            g.gain.value = 0.0;
            g.gain.setTargetAtTime(0.18, ctx.currentTime, 0.05);
            const pan = ctx.createStereoPanner();
            pan.pan.value = this.panFor(x);
            saw.connect(bp); nz.connect(bp); bp.connect(g); g.connect(pan);
            pan.connect(this.master);
            saw.start(); nz.start(); wob.start();
            this.drillNodes = { saw, nz, wob, g, pan };
        } else if (!on && this.drillNodes) {
            const n = this.drillNodes;
            this.drillNodes = null;
            n.g.gain.setTargetAtTime(0.0, this.ctx.currentTime, 0.06);
            setTimeout(() => { try { n.saw.stop(); n.nz.stop(); n.wob.stop(); } catch {} }, 400);
        } else if (on && this.drillNodes) {
            this.drillNodes.pan.pan.value = this.panFor(x);
        }
    }

    // Fire crackle: scheduled micro-bursts whose density follows the burning
    // cell count reported by the engine's grid census.
    setFireLevel(cells) {
        this.crackleLevel = Math.min(1, cells / 600);
        if (!this.ctx) return;
        if (this.crackleLevel > 0 && !this.crackleTimer) {
            this.crackleTimer = setInterval(() => {
                if (!this.enabled || this.crackleLevel <= 0) return;
                if (Math.random() < 0.25 + this.crackleLevel * 0.6) {
                    this.burst({
                        x: 200 + Math.random() * 400,
                        dur: 0.03 + Math.random() * 0.05,
                        gain: 0.05 + 0.10 * this.crackleLevel * Math.random(),
                        filterType: 'bandpass',
                        freq: 1800 + Math.random() * 2600, q: 1.2, reverb: 0.15
                    });
                }
            }, 70);
        } else if (this.crackleLevel <= 0 && this.crackleTimer) {
            clearInterval(this.crackleTimer);
            this.crackleTimer = null;
        }
    }

    dispose() {
        if (this.crackleTimer) clearInterval(this.crackleTimer);
        this.crackleTimer = null;
        this.drill(false);
        if (this.ctx) {
            this.ctx.close().catch(() => {});
            this.ctx = null;
        }
    }
}
