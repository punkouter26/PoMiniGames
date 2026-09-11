// fxShowcase.js — the live audio meter behind the Profile page's FX bench (§GFX).
//
// audioBus.getLevels() has always published a four-band read of the master
// analyser (bass / mid / treble / peak) and nothing ever called it. The bench on
// the Profile page is the first consumer: it turns the app's own output into
// four bars, which is the only way a player can see that the cue they just
// pressed actually reached the mix rather than being silently swallowed by a
// suspended AudioContext.
//
// The rAF loop lives here rather than in Blazor on purpose. Driving it from C#
// would mean a JS interop round trip per frame to read four floats and a
// StateHasChanged to write four widths — ~60 renders a second of the whole
// component tree for a decoration. This writes CSS custom properties directly
// and never re-renders anything.
//
// Exposed as window.PoFxShowcase.
(function () {
    'use strict';

    let _raf = 0;
    let _target = null;

    function frame() {
        if (!_target || !_target.isConnected) { stop(); return; }

        let levels = null;
        try {
            levels = window.PoAudioBus && window.PoAudioBus.getLevels
                ? window.PoAudioBus.getLevels()
                : null;
        } catch { levels = null; }

        // No audio graph yet (nothing has made a sound since load, so the context
        // has not been built) reads as silence rather than as an error — pressing
        // any cue button is what brings it to life, which is the bench's whole point.
        const l = levels || { bass: 0, mid: 0, treble: 0, peak: 0 };
        const s = _target.style;
        s.setProperty('--lvl-bass', (l.bass * 100).toFixed(1) + '%');
        s.setProperty('--lvl-mid', (l.mid * 100).toFixed(1) + '%');
        s.setProperty('--lvl-treble', (l.treble * 100).toFixed(1) + '%');
        s.setProperty('--lvl-peak', (l.peak * 100).toFixed(1) + '%');

        _raf = requestAnimationFrame(frame);
    }

    /**
     * Start writing levels into `selector`'s custom properties.
     * Idempotent — a second call retargets rather than starting a second loop.
     * @param {string} selector
     */
    function start(selector) {
        stop();
        _target = document.querySelector(selector);
        if (!_target) return;
        _raf = requestAnimationFrame(frame);
    }

    function stop() {
        if (_raf) cancelAnimationFrame(_raf);
        _raf = 0;
    }

    window.PoFxShowcase = { start: start, stop: stop };
})();
