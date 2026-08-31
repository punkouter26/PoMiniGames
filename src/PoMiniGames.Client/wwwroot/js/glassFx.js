// glassFx.js — scene-composited glass for HUD panels (§GFX-16).
//
// CSS backdrop-filter blurs whatever is *behind the element in DOM order*,
// which over a canvas reads as a flat smear. This module composites the actual
// game canvas: a small offscreen thumbnail of the live frame is blurred and
// handed to the panel as `--glass-capture`, so the panel's blur and tint land
// ON the scene content behind it — real glassmorphism, at thumbnail cost.
//
// Cost model: one 128px-wide drawImage + blur per interval per panel, gated by
// PoQuality (low tier and reduced-motion keep the plain backdrop-filter).
//
// Exposed as window.PoGlass.
(function () {
    'use strict';

    const CAPTURE_W = 128;
    let _timers = new Map();   // panel -> intervalId

    function allowed() {
        const q = window.PoQuality;
        if (!q) return false;
        if (q.tier() === 'low') return false;
        if (q.reduceFlashing()) return false; // motion-heavy live captures out
        return true;
    }

    function captureOnce(sourceCanvas, panel) {
        try {
            if (!sourceCanvas.width || !sourceCanvas.height) return;
            const w = CAPTURE_W;
            const h = Math.max(24, Math.round(CAPTURE_W * sourceCanvas.height / sourceCanvas.width));
            const off = glassFx._off || (glassFx._off = document.createElement('canvas'));
            off.width = w; off.height = h;
            const g = off.getContext('2d');
            g.filter = 'blur(5px) saturate(1.25) brightness(1.08)';
            g.drawImage(sourceCanvas, 0, 0, w, h);
            g.filter = 'none';
            panel.style.setProperty('--glass-capture', 'url("' + off.toDataURL('image/webp', 0.6) + '")');
            panel.setAttribute('data-glass-live', '');
        } catch { /* tainted canvas or gone — the CSS fallback still applies */ }
    }

    function attachPanel(panel, opts) {
        const o = opts || {};
        const source = o.source || document.querySelector('canvas');
        if (!panel || !source) return function () { };
        if (!allowed() || _timers.has(panel)) return function () { };

        captureOnce(source, panel);
        const id = setInterval(function () {
            if (!panel.isConnected) { clearInterval(id); _timers.delete(panel); return; }
            if (!allowed()) { panel.removeAttribute('data-glass-live'); return; }
            captureOnce(source, panel);
        }, o.intervalMs || 220);
        _timers.set(panel, id);
        return function () { clearInterval(id); _timers.delete(panel); panel.removeAttribute('data-glass-live'); };
    }

    // Attach every element matching `selector` to a source canvas — including
    // panels that mount LATER (pick card → place chip → podium swap as phases
    // change), so the sweep rescans each tick and forgets disconnected ones.
    // Games call this once after their canvas mounts.
    function attachHud(sourceCanvas, selector) {
        const sel = selector || '[data-glass]';
        const tracked = new Set();

        function sweep() {
            if (!allowed()) return;
            document.querySelectorAll(sel).forEach(function (p) {
                if (!p.isConnected) { tracked.delete(p); return; }
                tracked.add(p);
                captureOnce(sourceCanvas, p);
            });
        }

        sweep();
        const id = setInterval(function () {
            if (sourceCanvas && !sourceCanvas.isConnected) { clearInterval(id); return; }
            sweep();
        }, o_intervalMs);
        return function () {
            clearInterval(id);
            tracked.forEach(function (p) { p.removeAttribute('data-glass-live'); });
            tracked.clear();
        };
    }

    const o_intervalMs = 220;
    const glassFx = {
        attachPanel: attachPanel,
        attachHud: attachHud,
        stopAll: function () { _timers.forEach(function (id) { clearInterval(id); }); _timers.clear(); }
    };

    window.PoGlass = glassFx;
})();
