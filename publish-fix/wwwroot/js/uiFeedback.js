// Native Web Audio micro-feedback (Suggestion #9).
// A soft oscillator "tick" on primary tap targets — no audio asset is ever
// downloaded. The AudioContext is created lazily on the first user gesture to
// satisfy browser autoplay policy, and feedback is mutable via window.poUi.
(function () {
  'use strict';

  var ctx = null;
  function audioCtx() {
    if (ctx) return ctx;
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    return ctx;
  }

  function muted() {
    try { return localStorage.getItem('po-ui-sound') === 'off'; } catch (e) { return false; }
  }

  function blip(freq, dur, vol) {
    if (muted()) return;
    var c = audioCtx();
    if (!c) return;
    if (c.state === 'suspended') { c.resume(); }
    var t = c.currentTime;
    var osc = c.createOscillator();
    var gain = c.createGain();
    osc.connect(gain);
    gain.connect(c.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.start(t);
    osc.stop(t + dur);
  }

  window.poUi = {
    tick: function () { blip(660, 0.05, 0.06); },   // soft tap
    click: function () { blip(880, 0.04, 0.05); },  // crisper confirm
    setMuted: function (m) { try { localStorage.setItem('po-ui-sound', m ? 'off' : 'on'); } catch (e) {} }
  };

  // Delegated: any primary tap target gets instant sensory feedback without
  // each component having to wire it up (zero-waste footprint).
  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var hit = e.target.closest(
      'button, a.home-game-chip, .home-mode-btn, .gl-center-action, .gl-auth-button, .home-score-card');
    if (!hit || hit.disabled) return;
    window.poUi.tick();
  }, true);
})();
