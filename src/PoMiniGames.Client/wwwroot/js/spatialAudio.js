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

    window.PoSpatial = { panX: panX, panner3d: panner3d, playAt: playAt };
})();
