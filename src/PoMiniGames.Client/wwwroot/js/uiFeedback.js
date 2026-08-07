// Delegated micro-feedback on tap targets (Suggestion #9).
//
// This file used to own the SIXTH AudioContext in the app, wired straight to
// ctx.destination and gated on its own `po-ui-sound` localStorage key. That had
// two real consequences: its blips ignored the global mute and the master
// volume entirely (they were not on the mix graph at all), and it burned a
// hardware output slot against the browser's per-page context cap.
//
// It is now a thin delegate over the shared vocabulary in gameCues.js. It keeps
// its own listener because the *delegation* is the valuable part — every button
// in the app gets feedback without any component wiring it up — but the sound
// itself, the mute check and the mix routing all live in one place now.
//
// Loaded as a classic deferred script, so it cannot `import`. window.PoCue is
// published by the gameCues module, which evaluates later in the document; that
// is fine because nothing here touches it until a click actually happens.
(function () {
  'use strict';

  var LEGACY_KEY = 'po-ui-sound';

  function suppressed() {
    // Honoured for backwards compatibility — anyone who turned UI sound off
    // under the old key should stay off. Global mute is enforced downstream by
    // gameCues/audioBus, so it is deliberately not re-checked here.
    try { return localStorage.getItem(LEGACY_KEY) === 'off'; } catch (e) { return false; }
  }

  function cue(name, el) {
    if (suppressed()) return;
    if (!window.PoCue) return;   // modules not evaluated yet, or blocked
    window.PoCue.fire('ui', name, el ? { el: el } : undefined);
  }

  window.poUi = {
    tick: function () { cue('tap'); },
    click: function () { cue('confirm'); },
    back: function () { cue('back'); },
    error: function () { cue('error'); },
    setMuted: function (m) {
      try { localStorage.setItem(LEGACY_KEY, m ? 'off' : 'on'); } catch (e) {}
    }
  };

  // Delegated: any primary tap target gets instant sensory feedback without
  // each component having to wire it up (zero-waste footprint).
  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var hit = e.target.closest(
      'button, a.home-game-chip, .home-mode-btn, .gl-center-action, .gl-auth-button, .home-score-card');
    if (!hit || hit.disabled) return;
    // Destructive and primary actions get the two-note confirm; everything else
    // gets the quieter tap. Distinguishing them costs one attribute read and
    // makes the interface feel like it understands what was pressed.
    var kind = hit.classList.contains('gl-center-action') || hit.type === 'submit' ? 'confirm' : 'tap';
    cue(kind, hit);
  }, true);
})();
