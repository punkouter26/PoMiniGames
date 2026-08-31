// impactFx.js — impact events → the shared post-processing presets (§GFX-14).
//
// impactBus already produces punches/shake/trauma, and postFx already has the
// ingredients (punchAberration, punchRadial, rack focus) — but PoRacer kept a
// private bloom+speed-vignette and the other three.js games wired none of it.
// This module is the missing router: one call (`PoImpactFx.hit(kind, scale)`)
// applies the app-wide hit preset, tier-gated and flashing-guarded.
//
// Games with a composer call `frame(dt, composer)` per frame while an effect
// is armed; DOM-only games get the CSS flash route via palette pulses.
//
// Exposed as window.PoImpactFx.
(function () {
    'use strict';

    const MIN_GAP_MS = 90;      // aberration retrigger floor
    let _lastHit = 0;
    let _armed = null;          // { until, aberration, radial }

    function gate(scale) {
        const q = window.PoQuality;
        if (!q) return true;
        if (q.tier() === 'low') return false;
        if (q.reduceFlashing()) return false;           // no strobing, period
        if (q.tier() === 'medium' && scale < 0.6) return false;
        return true;
    }

    function hit(kind, scale) {
        const s = Math.max(0, Math.min(1.5, scale || 1));
        const now = performance.now();
        if (now - _lastHit < MIN_GAP_MS) return;
        _lastHit = now;

        // The physical layer (shake/trauma/vibration) belongs to impactBus and
        // stays unconditional — only the FLASH effects are tier-gated.
        if (window.PoImpact?.impact) window.PoImpact.impact(kind || 'hit', s);
        if (window.PoPalette?.pulse && kind === 'win') window.PoPalette.pulse('win');

        if (!gate(s)) return;

        // Arm the frame hook; the game's render loop drains it.
        _armed = {
            until: now + (kind === 'win' ? 900 : 450),
            aberration: (kind === 'win' ? 0.5 : 1.1) * s,
            radial: (kind === 'win' ? 0.35 : 0.8) * s
        };
    }

    // Called by a game's render loop. Returns true while an effect is live so
    // the composer knows to keep rendering the extra passes.
    function frame(nowSec) {
        if (!_armed) return false;
        const fx = window.PoThreeFx; // postFx's global alias, set by postFx.js
        const now = performance.now();
        if (now > _armed.until || !fx) { _armed = null; return false; }
        const t = (_armed.until - now) / (_armed.until - (now - 450));
        if (fx.punchAberration) fx.punchAberration(_armed.aberration * Math.max(0.15, t));
        if (fx.punchRadial) fx.punchRadial(_armed.radial * Math.max(0.15, t));
        return true;
    }

    window.PoImpactFx = {
        hit: hit,
        win: function (scale) { hit('win', scale == null ? 1 : scale); },
        lose: function (scale) { hit('hit', scale == null ? 0.8 : scale); },
        frame: frame,
        armed: function () { return _armed !== null; }
    };
})();
