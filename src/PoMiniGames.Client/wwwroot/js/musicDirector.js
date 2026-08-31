// musicDirector.js — one reactive soundtrack brain (§GFX-19).
//
// ambientMusic.js already synthesises layered music with an intensity-driven
// layer mixer — but nothing ever STARTED it, and nothing moved its intensity.
// This module is the missing conductor:
//
//   menu   (0.35, 96 bpm)  — the catalog's default presence
//   lobby  (0.55, 102 bpm) — waiting rooms; slightly forward
//   match  (0.80, 112 bpm) — play; intensity rides match events
//   verdict(0.95→rest)     — win/lose pulse, then falls back to previous state
//
// States arrive from PoPalette (route change → menu/game) and PoPalette.pulse
// (win/lose). Games can call PoMusicDirector.match(true/false) directly for
// finer control. Audio starts lazily on the first user gesture — browsers lock
// the AudioContext before one, and the §GFX-10 engine already treats that as a
// hard contract.
//
// Exposed as window.PoMusicDirector.
(function () {
    'use strict';

    const STATES = {
        menu:    { intensity: 0.35, tempo: 96 },
        lobby:   { intensity: 0.55, tempo: 102 },
        match:   { intensity: 0.80, tempo: 112 },
    };

    let _state = 'menu';
    let _gestureBound = false;
    let _starting = false;
    let _verdictUntil = 0;

    function ensureGesture() {
        if (_gestureBound) return;
        _gestureBound = true;
        const kick = function () {
            document.removeEventListener('pointerdown', kick);
            document.removeEventListener('keydown', kick);
            apply(true);
        };
        document.addEventListener('pointerdown', kick, { once: true });
        document.addEventListener('keydown', kick, { once: true });
    }

    function apply(forceStart) {
        const am = window.PoAmbientMusic;
        if (!am) return;
        const cfg = STATES[_state] || STATES.menu;
        // A verdict window overrides the resting intensity briefly.
        const inVerdict = Date.now() < _verdictUntil;
        const intensity = inVerdict ? 0.95 : cfg.intensity;

        try {
            if (!am.isPlaying()) {
                if (!forceStart && !_starting) return;  // wait for the gesture kick
                if (_starting) return;
                _starting = true;
                Promise.resolve(am.start('default', 0.12)).catch(function () { }).finally(function () { _starting = false; });
            }
            am.setIntensity ? am.setIntensity(intensity) : null;
            am.setTempo ? am.setTempo(inVerdict ? cfg.tempo + 8 : cfg.tempo) : null;
        } catch { /* the soundtrack must never be the thing that breaks */ }
    }

    function setState(s) {
        if (!STATES[s]) return;
        _state = s;
        apply(false);
    }

    // Verdict stinger: brief intensity spike; the palette pulse already shifted
    // the visuals — this is its audio twin.
    function verdict(win) {
        _verdictUntil = Date.now() + (win ? 2200 : 1600);
        apply(true);
        setTimeout(function () { apply(false); }, _verdictUntil - Date.now() + 50);
    }

    // Route changes flow through PoPalette; piggyback its context signal.
    const paletteWatch = setInterval(function () {
        const ctx = window.PoPalette?.context?.();
        const want = ctx === 'game' ? 'match' : 'menu';
        if (want !== _state) setState(want);
    }, 1200);

    ensureGesture();

    window.PoMusicDirector = {
        setState: setState,
        match: function (on) { setState(on ? 'match' : 'menu'); },
        lobby: function () { setState('lobby'); },
        verdict: verdict,
        state: function () { return _state; }
    };
})();
