// spatialAudio.js — HRTF/stereo positioning for game sounds (§GFX-20).
//
// acoustics.js already does doppler; this adds the missing half: positional
// panning. Two levels:
//   • panX(x, width)  — cheap normalized stereo pan for 2D boards/canvas games.
//   • panner3d(x,y,z) — a real HRTF PannerNode for three.js game buses, with
//     the listener parked at the camera origin the games already assume.
// Both land on the named audioBus bus so the reverb/compressor chain applies.
//
// Exposed as window.PoSpatial.
(function () {
    'use strict';

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    // 2D: x in px within a stage of `width` → -1..1 stereo pan. Cheap and
    // physically convincing for board games where the third axis is a lie.
    function panX(x, width) {
        if (!width) return 0;
        return clamp((x / width) * 2 - 1, -1, 1);
    }

    // Builds an HRTF panner on the given AudioContext. The app's listener sits
    // at the origin looking down -Z (matching how every game camera frames the
    // stage), so callers pass world coords relative to that.
    function panner3d(ctx, opts) {
        const o = opts || {};
        const p = ctx.createPanner();
        p.panningModel = 'HRTF';                 // the actual point of this module
        p.distanceModel = o.distanceModel || 'inverse';
        p.refDistance = o.refDistance || 1.5;
        p.maxDistance = o.maxDistance || 24;
        p.rolloffFactor = o.rolloffFactor == null ? 1.1 : o.rolloffFactor;
        if (p.positionX) {
            p.positionX.value = o.x || 0;
            p.positionY.value = o.y || 0;
            p.positionZ.value = o.z || -2;
        } else {
            p.setPosition(o.x || 0, o.y || 0, o.z || -2); // Safari's older path
        }
        return p;
    }

    // One-shot convenience: play a short synthesized blip from a position.
    // `voice` is a factory(ctx) returning {node, stop()} — keeps this module
    // ignorant of HOW sounds are made (that's materialAudio/gameCues' job).
    function playAt(ctx, dest, voice, pos) {
        if (!ctx || !dest) return null;
        const p = panner3d(ctx, pos);
        p.connect(dest);
        const v = voice(ctx);
        v.node.connect(p);
        if (v.start) v.start();
        if (v.stop) v.stop();
        return p;
    }

    /**
     * Fire a cue from a position on the plane, with stereo placement and doppler
     * applied — the 2D game entry point (§GFX).
     *
     * This is the call that was missing. panX and dopplerRatio2D were both written
     * for PoRacer and PoSports (acoustics.js names them in its own docs), and
     * neither game ever called either: every cue in the app landed dead centre at
     * the pitch it was written at. Combining them here rather than in the games
     * keeps one interop call per event instead of three, and means a caller cannot
     * apply pan without also applying the doppler that makes it convincing.
     *
     * @param {string} scope cue scope ('poracer', 'posports', …)
     * @param {string} name  cue name within that scope
     * @param {object} o
     * @param {number} o.dx  source position relative to the listener, across
     * @param {number} o.dy  source position relative to the listener, depth
     * @param {number} [o.vx] source velocity, across
     * @param {number} [o.vy] source velocity, depth
     * @param {number} [o.spread=12] world units mapped to a full stereo sweep
     * @param {number} [o.gain=1]
     * @param {number} [o.scale=1]
     */
    function cue2D(scope, name, o) {
        const opts = o || {};
        const spread = opts.spread || 12;
        // Pan straight from the lateral offset rather than through panX: panX takes
        // a pixel position within a stage width, and what a game has at an event is
        // an offset from the listener. Same clamp, right units.
        const pan = clamp((opts.dx || 0) / spread, -1, 1);

        let pitch = 1;
        try {
            // Distance attenuation is left to the cue's own gain and the caller:
            // the doppler ratio is about approach speed, and multiplying the two
            // concerns here would hide which one produced a wrong-sounding result.
            pitch = window.PoAcoustics
                ? window.PoAcoustics.dopplerRatio2D(opts.dx || 0, opts.dy || 0, opts.vx || 0, opts.vy || 0)
                : 1;
        } catch { pitch = 1; }

        try {
            window.PoCue && window.PoCue.fire(scope, name, {
                pan: pan,
                pitch: pitch,
                gain: opts.gain == null ? 1 : opts.gain,
                scale: opts.scale == null ? 1 : opts.scale,
            });
        } catch { /* feedback is never fatal */ }
    }

    window.PoSpatial = { panX: panX, panner3d: panner3d, playAt: playAt, cue2D: cue2D };
})();
