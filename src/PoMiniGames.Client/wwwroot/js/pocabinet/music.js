// pocabinet/music.js
//
// The adaptive race score. Zero assets: every note is synthesized here, scheduled on the
// AudioContext's own clock, and the layers follow the race (race state comes in from audio.js,
// which owns this module and its bus; acoustics.js works the state out from the race).
//
// Clock: a lookahead scheduler. pump() runs every frame (and on a 50 ms backup timer for slow
// frames) and books every sixteenth that falls inside the next LOOKAHEAD seconds at its exact
// ctx.currentTime, so the groove never follows the frame rate. A hitch or a hidden tab skips the
// missed steps on the grid instead of bunching them.
//
// The tune: 124 BPM, A minor, i – VI – III – VII (Am F C/G G), one chord a bar.
//
//   • pad    — three chord tones, each two detuned saws, through a slowly breathing lowpass.
//   • pulse  — an eighth-note arpeggio pluck (saw through an enveloped lowpass) with a
//              dotted-eighth echo. With the pad, the bed on the grid and the countdown.
//   • bass   — two-operator FM (sine modulating a sine, the index enveloped per note) on the
//              roots, from GO.
//   • drums  — a kick (a sine dropping 150 → 45 Hz), noise hats and a noise clap. Their density
//              follows the battle: hats when a car is within reach, four on the floor in a
//              fight, the clap and sixteenth hats nose to tail.
//   • final lap — the key lifts a whole tone at the next bar, the pad brightens, the drums
//              stay in, a crash marks it.
//   • overtake — stinger(): a bright chord stab on the next sixteenth and a lowpass sweep
//              opening the whole score back up.
//   • finish — a resolved ending at the next bar: VI, VII, then A major (the Picardy third),
//              a kick and a crash, and the score fades out over it.
//
// Graph: layers ─► mix ─► end envelope ─► sweep lowpass ─► stab joins ─► load duck ─► hit duck
//        ─► on/off ─► dest (audio.js's music bus, which runs through the slow-mo lowpass)
//
// Ducking, sidechain style: the engine load pulls the score down (load duck, per frame) and
// every impact punches it down for a moment (hit duck). Every continuous control is
// setTargetAtTime; notes are booked ahead with setValueAtTime/ramps on their own gain nodes,
// so the two never fight over one parameter.

const BPM = 124;
const STEP = 60 / BPM / 4;     // one sixteenth, seconds
const BAR = STEP * 16;
const LOOKAHEAD = 0.25;        // seconds of notes booked ahead of ctx.currentTime
const PUMP_MS = 50;            // backup timer; the timing itself is always ctx time

// One chord a bar. pad: MIDI voicing (smooth voice leading); bass: MIDI root.
const PROG = [
    { pad: [57, 60, 64], bass: 33 },   // Am
    { pad: [53, 57, 60], bass: 29 },   // F
    { pad: [55, 60, 64], bass: 36 },   // C/G
    { pad: [55, 59, 62], bass: 31 },   // G
];
const RESOLVE = { pad: [57, 61, 64], bass: 33 };   // A major: the close
const ARP = [0, 1, 2, 1, 0, 2, 1, 2];               // eighth-note arpeggio over the chord, an octave up

// Layer levels per phase (0..1, scaled by each layer's own mix level).
const LEVELS = {
    grid: { pad: 0.85, pulse: 0.75, bass: 0 },
    race: { pad: 0.55, pulse: 0.5, bass: 0.9 },
    final: { pad: 0.7, pulse: 0.7, bass: 1 },
    off: { pad: 0, pulse: 0, bass: 0 },
};

const hz = m => 440 * Math.pow(2, (m - 69) / 12);

export class Music {
    /**
     * @param ctx    AudioContext
     * @param noise  a looping white-noise AudioBuffer (audio.js's shared one)
     * @param dest   where the score goes (the music bus)
     */
    constructor(ctx, noise, dest) {
        this.ctx = ctx;
        this.noise = noise;
        this.dest = dest;
        this.enabled = true;
        this.paused = false;
        this.running = false;     // the scheduler is booking notes
        this.phase = 'off';
        this.battle = 0;          // 0..1 how close a fight the ear is in (smoothed)
        this.drive = 0;           // drum density, follows battle
        this.finalLap = false;
        this.key = 0;             // semitones: +2 on the final lap
        this.lifted = false;
        this.step = 0;
        this.nextT = 0;
        this.wantEnd = false;
        this.ending = null;       // { bar } the outro started on
        this.done = false;        // outro played: silent until the next race
        this.offAt = 0;
        this.timer = null;
        this.lastT = 0;
        this.stats = { notes: 0, kicks: 0, hats: 0, claps: 0, stings: 0 };
        this.build();
    }

    // ── Graph ────────────────────────────────────────────────────────────

    gain(v = 0) { const g = this.ctx.createGain(); g.gain.value = v; return g; }

    filter(type, f, q = 0.7) {
        const b = this.ctx.createBiquadFilter();
        b.type = type; b.frequency.value = f; b.Q.value = q;
        return b;
    }

    build() {
        const ctx = this.ctx;
        this.out = this.gain(this.enabled ? 1 : 0);       // the Music setting
        this.hitDuck = this.gain(1);
        this.loadDuck = this.gain(1);
        this.post = this.gain(0.45);                      // overall score level
        this.sweep = this.filter('lowpass', 20000, 0.9);  // the overtake sweep
        this.endEnv = this.gain(1);                       // the outro's fade
        this.mix = this.gain(1);
        this.mix.connect(this.endEnv);
        this.endEnv.connect(this.sweep);
        this.sweep.connect(this.post);
        this.post.connect(this.loadDuck);
        this.loadDuck.connect(this.hitDuck);
        this.hitDuck.connect(this.out);
        this.out.connect(this.dest);

        // Pad: 3 voices × 2 detuned saws.
        this.padFilter = this.filter('lowpass', 1100, 0.8);
        this.padLayer = this.gain(0);
        this.padFilter.connect(this.padLayer);
        this.padLayer.connect(this.mix);
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.09;
        const lfoDepth = this.gain(260);
        lfo.connect(lfoDepth); lfoDepth.connect(this.padFilter.frequency);
        this.padOsc = [];
        for (let v = 0; v < 3; v++) {
            for (const cents of [-8, 8]) {
                const o = ctx.createOscillator();
                o.type = 'sawtooth';
                o.frequency.value = hz(PROG[0].pad[v]);
                o.detune.value = cents + (v - 1) * 2;
                const g = this.gain(0.05);
                o.connect(g); g.connect(this.padFilter);
                this.padOsc.push(o);
            }
        }

        // Pulse: one saw, a note envelope, a filter envelope, a dotted-eighth echo.
        this.pulseOsc = ctx.createOscillator();
        this.pulseOsc.type = 'sawtooth';
        this.pulseFilter = this.filter('lowpass', 600, 3);
        this.pulseEnv = this.gain(0);
        this.pulseLayer = this.gain(0);
        this.pulseOsc.connect(this.pulseFilter);
        this.pulseFilter.connect(this.pulseEnv);
        this.pulseEnv.connect(this.pulseLayer);
        this.pulseLayer.connect(this.mix);
        const echo = ctx.createDelay(1);
        echo.delayTime.value = STEP * 3;
        const fb = this.gain(0.32), wet = this.gain(0.3);
        const echoLp = this.filter('lowpass', 2400, 0.5);
        this.pulseLayer.connect(echo);
        echo.connect(echoLp); echoLp.connect(fb); fb.connect(echo);
        echoLp.connect(wet); wet.connect(this.mix);

        // Bass: two-operator FM.
        this.bassCar = ctx.createOscillator();
        this.bassMod = ctx.createOscillator();
        this.bassCar.type = 'sine';
        this.bassMod.type = 'sine';
        this.bassIndex = this.gain(0);
        this.bassMod.connect(this.bassIndex);
        this.bassIndex.connect(this.bassCar.frequency);
        this.bassEnv = this.gain(0);
        const bassLp = this.filter('lowpass', 900, 0.7);
        this.bassLayer = this.gain(0);
        this.bassCar.connect(this.bassEnv);
        this.bassEnv.connect(bassLp);
        bassLp.connect(this.bassLayer);
        this.bassLayer.connect(this.mix);

        // Drums: hits are made per step into this layer.
        this.drumLayer = this.gain(0);
        this.drumLayer.connect(this.mix);
        // Stabs go in after the sweep, so the sweep never swallows the stinger.
        this.stab = this.gain(1);
        this.stab.connect(this.post);

        for (const o of [lfo, ...this.padOsc, this.pulseOsc, this.bassCar, this.bassMod]) o.start();
    }

    // ── Control (audio.js calls these) ───────────────────────────────────

    /** The Music setting. Off fades the score out and stops booking notes. */
    setEnabled(on) {
        this.enabled = !!on;
        this.out.gain.setTargetAtTime(this.enabled ? 1 : 0, this.ctx.currentTime, 0.3);
        if (!this.enabled) this.halt();
    }

    /** Pause menu: stop booking notes (the master gain already ducks); pick up on the grid after. */
    setPaused(p) {
        this.paused = !!p;
        if (!this.paused && this.running) this.nextT = Math.max(this.nextT, this.ctx.currentTime + 0.05);
    }

    /**
     * Per frame: { phase: 'off' | 'grid' | 'race' | 'finish', battle 0..1, finalLap }.
     * Starts, shapes and ends the score.
     */
    update(state) {
        const t = this.ctx.currentTime;
        const dt = this.lastT ? Math.min(0.2, Math.max(0, t - this.lastT)) : 0;
        this.lastT = t;
        const phase = state?.phase || 'off';
        const battle = Math.min(1, Math.max(0, Number(state?.battle) || 0));
        this.finalLap = !!state?.finalLap;
        // The battle comes in fast and lets go slowly, so a gap breathing around the
        // threshold does not chop the drums in and out.
        this.battle += (battle - this.battle) * (1 - Math.exp(-dt * (battle > this.battle ? 2.5 : 0.5)));

        if (phase === 'grid' && (this.done || this.ending || this.phase === 'off' || this.phase === 'finish')) this.reset();
        if (phase !== this.phase) {
            if (phase === 'finish' && this.running) this.wantEnd = true;
            this.phase = phase;
        }
        if (!this.enabled || this.done) return;
        if (!this.running && (phase === 'grid' || phase === 'race')) this.start();
        if (!this.running) return;

        if (!this.ending) {
            const lv = phase === 'off' ? LEVELS.off : phase === 'grid' ? LEVELS.grid : this.finalLap ? LEVELS.final : LEVELS.race;
            const k = phase === 'off' ? 0.6 : 0.4;
            this.padLayer.gain.setTargetAtTime(lv.pad, t, k);
            this.pulseLayer.gain.setTargetAtTime(lv.pulse, t, k);
            this.bassLayer.gain.setTargetAtTime(lv.bass, t, k);
            const racing = phase === 'race' || phase === 'finish';
            const drive = racing ? Math.max(this.battle, this.finalLap ? 0.45 : 0) : 0;
            this.drive = drive;
            this.drumLayer.gain.setTargetAtTime(drive > 0.08 ? 0.55 + 0.45 * drive : 0, t, 0.3);
            const bright = phase === 'grid' ? 850 : this.finalLap ? 1900 : 1250;
            this.padFilter.frequency.setTargetAtTime(bright + drive * 700, t, 0.8);
            if (phase === 'off') {
                if (!this.offAt) this.offAt = t;
                if (t - this.offAt > 3) this.halt();
            } else {
                this.offAt = 0;
            }
        }
        this.pump();
    }

    /** Sidechain from the engine: load 0..1 (only while racing) pulls the score down. */
    duck(load) {
        const l = Math.min(1, Math.max(0, Number(load) || 0));
        this.loadDuck.gain.setTargetAtTime(1 - 0.42 * l, this.ctx.currentTime, 0.12);
    }

    /** An impact punches the score down and lets it back up. */
    hit(strength) {
        const s = Math.min(1, Math.max(0, Number(strength) || 0));
        const p = this.hitDuck.gain, t = this.ctx.currentTime;
        if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t); else p.cancelScheduledValues(t);
        p.setTargetAtTime(1 - 0.75 * s, t, 0.01);
        p.setTargetAtTime(1, t + 0.08, 0.45);
    }

    /** Overtake: a chord stab on the next sixteenth and the whole score swept open. */
    stinger() {
        if (!this.running || !this.enabled || this.ending || this.paused) return;
        const ctx = this.ctx;
        const now = ctx.currentTime;
        const t = this.nextT - Math.floor((this.nextT - (now + 0.03)) / STEP) * STEP;
        const chord = PROG[Math.floor(this.step / 16) % 4];
        for (const m of [chord.pad[0] + 12, chord.pad[1] + 12, chord.pad[2] + 12, chord.pad[0] + 24]) {
            for (const c of [-9, 9]) {
                const o = ctx.createOscillator();
                o.type = 'sawtooth';
                o.frequency.value = hz(m + this.key);
                o.detune.value = c;
                const f = this.filter('lowpass', 7000, 1.2);
                f.frequency.setValueAtTime(7000, t);
                f.frequency.setTargetAtTime(900, t + 0.02, 0.18);
                const g = this.gain(0);
                g.gain.setValueAtTime(0, t);
                g.gain.linearRampToValueAtTime(0.03, t + 0.006);
                g.gain.setTargetAtTime(0, t + 0.08, 0.16);
                o.connect(f); f.connect(g); g.connect(this.stab);
                o.start(t); o.stop(t + 1);
            }
        }
        this.noiseHit(t, 'bandpass', 5200, 0.9, 0.6, 0.05, this.stab, 900);
        const sw = this.sweep.frequency;
        if (sw.cancelAndHoldAtTime) sw.cancelAndHoldAtTime(t); else sw.cancelScheduledValues(t);
        sw.setValueAtTime(420, t);
        sw.exponentialRampToValueAtTime(20000, t + 1.3);
        this.stats.stings++;
    }

    /** Silence now (race torn down, results, replay). The next grid starts it again. */
    stop() {
        this.halt();
        this.phase = 'off';
        this.done = false;
        this.ending = null;
        this.wantEnd = false;
    }

    // ── Scheduler ────────────────────────────────────────────────────────

    start() {
        const t = this.ctx.currentTime;
        this.running = true;
        this.step = 0;
        this.nextT = t + 0.06;
        this.lifted = false;
        this.key = 0;
        this.offAt = 0;
        this.endEnv.gain.cancelScheduledValues(t);
        this.endEnv.gain.setTargetAtTime(1, t, 0.05);
        if (!this.timer) this.timer = window.setInterval(() => this.pump(), PUMP_MS);
    }

    halt() {
        this.running = false;
        if (this.timer) { window.clearInterval(this.timer); this.timer = null; }
        const t = this.ctx.currentTime;
        for (const g of [this.padLayer, this.pulseLayer, this.bassLayer, this.drumLayer]) g.gain.setTargetAtTime(0, t, 0.25);
    }

    reset() {
        this.done = false;
        this.ending = null;
        this.wantEnd = false;
        if (this.running) this.halt();
    }

    pump() {
        if (!this.running || this.paused || !this.enabled) return;
        const now = this.ctx.currentTime;
        if (this.nextT < now) {
            // Fell behind (a hitch, a hidden tab): skip on the grid rather than bunch notes.
            const n = Math.ceil((now - this.nextT) / STEP);
            this.step += n;
            this.nextT += n * STEP;
        }
        while (this.running && this.nextT < now + LOOKAHEAD) {
            this.play(this.step, this.nextT);
            this.step++;
            this.nextT += STEP;
        }
    }

    /** Book everything on sixteenth `step` at ctx time `t`. */
    play(step, t) {
        const s = step % 16;
        const bar = Math.floor(step / 16);
        if (s === 0) {
            if (this.wantEnd && !this.ending) { this.ending = { bar }; this.wantEnd = false; }
            if (!this.ending) {
                const key = this.finalLap ? 2 : 0;
                if (key !== this.key) {
                    this.key = key;
                    if (key && !this.lifted) { this.lifted = true; this.crash(t, 0.5); }
                }
            }
        }
        if (this.ending) { this.playEnding(step, t, bar - this.ending.bar, s); return; }

        const chord = PROG[bar % 4];
        if (s === 0) this.setPad(chord.pad, t);
        if (s % 2 === 0) this.pluck(chord.pad[ARP[s >> 1]] + 12, t, s % 4 === 0 ? 1 : 0.7);
        if (this.bassLayer.gain.value > 0.02 || this.phase === 'race') {
            if (s % 2 === 0) this.bassNote(chord.bass + (s === 6 || s === 14 ? 12 : 0), t, STEP * 1.6, s % 4 === 0 ? 1 : 0.75);
            else if (s === 15 && this.drive > 0.5) this.bassNote(chord.bass + 12, t, STEP * 0.8, 0.55);
        }
        const d = this.drive;
        if (d > 0.08) {
            if (d > 0.3 ? s % 4 === 0 : (s === 0 || s === 8)) this.kick(t, s === 0 ? 1 : 0.85);
            if (d > 0.7 ? true : d > 0.4 ? s % 2 === 0 : s % 4 === 2) this.hat(t, s % 4 === 2 ? 1 : 0.55, d > 0.5 && s % 8 === 6);
            if (d > 0.55 && (s === 4 || s === 12)) this.clap(t);
        }
    }

    /** The outro: bar 0 is VI then VII, bar 1 lands on A major and lets it ring out. */
    playEnding(step, t, rel, s) {
        if (rel === 0) {
            const chord = s < 8 ? PROG[1] : PROG[3];
            if (s === 0 || s === 8) this.setPad(chord.pad, t);
            if (s % 2 === 0) this.pluck(chord.pad[ARP[s >> 1]] + 12, t, 0.9);
            if (s % 2 === 0) this.bassNote(chord.bass, t, STEP * 1.6, 0.9);
            if (s % 4 === 0) this.kick(t, 0.9);
            if (s >= 12) this.hat(t, 0.4 + (s - 12) * 0.2, false);
            if (s === 14) this.clap(t);
        } else if (rel === 1) {
            if (s === 0) {
                this.setPad(RESOLVE.pad, t);
                this.bassNote(RESOLVE.bass, t, BAR * 1.5, 1);
                this.kick(t, 1);
                this.crash(t, 1);
                const now = this.ctx.currentTime;
                for (const g of [this.padLayer, this.pulseLayer, this.bassLayer]) g.gain.setTargetAtTime(g === this.pulseLayer ? 0.8 : 0.9, now, 0.1);
                this.padFilter.frequency.setTargetAtTime(2400, t, 0.4);
                this.endEnv.gain.setValueAtTime(1, t + STEP * 4);
                this.endEnv.gain.setTargetAtTime(0, t + STEP * 4, 1.1);
            }
            // A rising arpeggio over the close: A C# E A.
            if (s < 4) this.pluck([69, 73, 76, 81][s], t, 0.9 - s * 0.1);
        } else {
            this.done = true;
            this.running = false;
            if (this.timer) { window.clearInterval(this.timer); this.timer = null; }
            const t2 = this.ctx.currentTime + 6;
            for (const g of [this.padLayer, this.pulseLayer, this.bassLayer, this.drumLayer]) g.gain.setTargetAtTime(0, t2, 0.3);
        }
    }

    // ── Voices ───────────────────────────────────────────────────────────

    setPad(notes, t) {
        for (let v = 0; v < 3; v++) {
            const f = hz(notes[v] + this.key);
            this.padOsc[v * 2].frequency.setTargetAtTime(f, t, 0.025);
            this.padOsc[v * 2 + 1].frequency.setTargetAtTime(f, t, 0.025);
        }
    }

    pluck(midi, t, vel) {
        this.pulseOsc.frequency.setValueAtTime(hz(midi + this.key), t);
        const f = this.pulseFilter.frequency;
        f.setValueAtTime(700 + 2600 * vel, t);
        f.setTargetAtTime(380, t + 0.004, 0.07);
        const g = this.pulseEnv.gain;
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(0.11 * vel, t + 0.004);
        g.setTargetAtTime(0, t + 0.01, 0.06);
        this.stats.notes++;
    }

    bassNote(midi, t, len, vel) {
        const f = hz(midi + this.key);
        this.bassCar.frequency.setValueAtTime(f, t);
        this.bassMod.frequency.setValueAtTime(f, t);
        const ix = this.bassIndex.gain;
        ix.setValueAtTime(f * 3.2 * vel, t);
        ix.setTargetAtTime(f * 0.5, t + 0.003, 0.07);
        const g = this.bassEnv.gain;
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(0.32 * vel, t + 0.006);
        g.setTargetAtTime(0.18 * vel, t + 0.02, 0.12);
        g.setTargetAtTime(0, t + len, 0.03);
    }

    kick(t, vel) {
        const o = this.ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(150, t);
        o.frequency.exponentialRampToValueAtTime(45, t + 0.11);
        const g = this.gain(0);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.42 * vel, t + 0.003);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
        o.connect(g); g.connect(this.drumLayer);
        o.start(t); o.stop(t + 0.4);
        // The pump: everything else in the score ducks under the kick.
        const m = this.mix.gain;
        m.setValueAtTime(1, t);
        m.linearRampToValueAtTime(0.62, t + 0.01);
        m.setTargetAtTime(1, t + 0.03, 0.08);
        this.stats.kicks++;
    }

    hat(t, vel, open) {
        this.noiseHit(t, 'highpass', 7200, 0.7, open ? 0.22 : 0.035, 0.05 * vel, this.drumLayer);
        this.stats.hats++;
    }

    clap(t) {
        for (const dt of [0, 0.011, 0.022]) this.noiseHit(t + dt, 'bandpass', 1700, 0.9, 0.12, 0.09, this.drumLayer);
        this.stats.claps++;
    }

    crash(t, vel) {
        this.noiseHit(t, 'highpass', 4200, 0.5, 1.6, 0.07 * vel, this.drumLayer.gain.value > 0.05 ? this.drumLayer : this.mix);
    }

    /** A noise burst: `dur` is the decay's time constant ×5; `to` sweeps the filter. */
    noiseHit(t, type, freq, q, dur, peak, dest, to) {
        const src = this.ctx.createBufferSource();
        src.buffer = this.noise;
        const f = this.filter(type, freq, q);
        if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
        const g = this.gain(0);
        g.gain.setValueAtTime(peak, t);
        g.gain.setTargetAtTime(0, t + 0.002, dur / 5);
        src.connect(f); f.connect(g); g.connect(dest);
        src.start(t, Math.random() * 1.5, dur + 0.05);
    }

    /** For the harness: what the score is doing. */
    debug() {
        return {
            enabled: this.enabled, running: this.running, paused: this.paused, phase: this.phase,
            battle: +this.battle.toFixed(3), drive: +this.drive.toFixed(3), finalLap: this.finalLap, key: this.key,
            ending: !!this.ending, done: this.done, step: this.step,
            layers: {
                pad: +this.padLayer.gain.value.toFixed(3), pulse: +this.pulseLayer.gain.value.toFixed(3),
                bass: +this.bassLayer.gain.value.toFixed(3), drums: +this.drumLayer.gain.value.toFixed(3),
            },
            duck: { load: +this.loadDuck.gain.value.toFixed(3), hit: +this.hitDuck.gain.value.toFixed(3) },
            sweep: Math.round(this.sweep.frequency.value), stats: { ...this.stats },
        };
    }
}
