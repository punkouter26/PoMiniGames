// materialAudio.js — surface-aware impact sounds, all synthesised (§GFX-18).
//
// acoustics.js gave each game a reverb *space*; this gives impacts a
// *material*. Wood, metal, glass and stone are synthesised from oscillators +
// shaped noise on the shared audioBus — no samples, per the §GFX-10 contract —
// and land through spatialAudio so off-center hits pan to where they happened.
//
// Interface: PoMaterialAudio.hit('wood'|'metal'|'glass'|'stone', intensity, panX)
//
// Exposed as window.PoMaterialAudio.
(function () {
    'use strict';

    // Voice recipes. freq/decay/noise shaped per material family; the goal is
    // instant recognisability at game volume, not physical modeling.
    const VOICES = {
        wood: { thump: 95, partials: [], noiseHz: 420, noiseQ: 1.2, noiseMs: 70, decay: 0.14 },
        stone: { thump: 55, partials: [], noiseHz: 260, noiseQ: 0.8, noiseMs: 90, decay: 0.12 },
        metal: { thump: 0, partials: [[412, 0.5, 0.5], [703, 0.35, 0.38], [1187, 0.22, 0.24]], noiseHz: 3800, noiseQ: 2.5, noiseMs: 40, decay: 0.55 },
        glass: { thump: 0, partials: [[2380, 0.4, 0.30], [3520, 0.3, 0.20], [5274, 0.2, 0.12]], noiseHz: 6200, noiseQ: 1.8, noiseMs: 50, decay: 0.4 },
    };

    function now(ctx) { return ctx.currentTime; }

    function hit(material, intensity, panX) {
        const bus = window.PoAudioBus;
        if (!bus?.isAvailable?.() || bus.isMuted?.()) return;
        const v = VOICES[material] || VOICES.wood;
        const i = Math.max(0.1, Math.min(1, intensity == null ? 0.7 : intensity));

        Promise.all([bus.contextSync(), bus.busSync('sfx')]).then(function (r) {
            const ctx = r[0], dest = r[1];
            if (!ctx || !dest) return;
            const t0 = now(ctx);

            // Positional pan (§GFX-20): panX is -1..1; skip the node at center.
            let out = dest;
            let panner = null;
            if (typeof panX === 'number' && Math.abs(panX) > 0.05) {
                panner = ctx.createStereoPanner();
                panner.pan.value = Math.max(-1, Math.min(1, panX));
                panner.connect(dest);
                out = panner;
            }

            const master = ctx.createGain();
            master.gain.value = 0.5 * i;
            master.connect(out);

            // Body thump.
            if (v.thump > 0) {
                const osc = ctx.createOscillator();
                const g = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(v.thump * (0.92 + i * 0.16), t0);
                osc.frequency.exponentialRampToValueAtTime(Math.max(30, v.thump * 0.55), t0 + v.decay);
                g.gain.setValueAtTime(1, t0);
                g.gain.exponentialRampToValueAtTime(0.001, t0 + v.decay);
                osc.connect(g).connect(master);
                osc.start(t0); osc.stop(t0 + v.decay + 0.02);
            }

            // Inharmonic partials (metal/glass ring).
            for (const p of v.partials) {
                const osc = ctx.createOscillator();
                const g = ctx.createGain();
                osc.type = 'triangle';
                osc.frequency.value = p[0];
                g.gain.setValueAtTime(p[1] * i, t0);
                g.gain.exponentialRampToValueAtTime(0.001, t0 + v.decay * p[2] * 3);
                osc.connect(g).connect(master);
                osc.start(t0); osc.stop(t0 + v.decay * p[2] * 3 + 0.02);
            }

            // Contact noise through a material-colored bandpass.
            const nLen = Math.max(1, Math.floor(ctx.sampleRate * (v.noiseMs / 1000)));
            const buf = ctx.createBuffer(1, nLen, ctx.sampleRate);
            const ch = buf.getChannelData(0);
            for (let s = 0; s < nLen; s++) ch[s] = (Math.random() * 2 - 1) * (1 - s / nLen);
            const noise = ctx.createBufferSource(); noise.buffer = buf;
            const bp = ctx.createBiquadFilter();
            bp.type = 'bandpass'; bp.frequency.value = v.noiseHz; bp.Q.value = v.noiseQ;
            const ng = ctx.createGain(); ng.gain.value = 0.9 * i;
            noise.connect(bp).connect(ng).connect(master);
            noise.start(t0);

            // GC: everything self-stops; the pan node dies with its source.
            if (panner) setTimeout(function () { try { panner.disconnect(); } catch { } }, 800);
        }).catch(function () { /* audio garnish — never break gameplay */ });
    }

    window.PoMaterialAudio = { hit: hit, materials: Object.keys(VOICES) };
})();
