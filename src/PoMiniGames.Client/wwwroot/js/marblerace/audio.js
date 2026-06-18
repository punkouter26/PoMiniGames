// audio.js — procedural Web Audio: impact "clinks" + win/lose result sting + mute.
// No asset files: everything is synthesized with oscillators.

export function createAudio() {
  let ctx = null;
  let muted = false;
  let lastClink = 0;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // A short metallic clink. volume/pitch scale with impact speed.
  function playClink(speed) {
    if (muted) return;
    const c = ensure();
    if (!c) return;
    const now = c.currentTime;
    if (now - lastClink < 0.02) return; // throttle spam
    lastClink = now;

    const v = Math.min(1, speed / 22);
    const freq = 320 + v * 900;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.6, now + 0.08);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.05 + v * 0.18, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(gain).connect(c.destination);
    osc.start(now);
    osc.stop(now + 0.14);
  }

  function tone(freq, start, dur, peak, type) {
    const c = ctx;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  // Win = rising triad, lose = falling minor.
  function playSting(win) {
    if (muted) return;
    const c = ensure();
    if (!c) return;
    const t = c.currentTime + 0.02;
    const notes = win ? [523.25, 659.25, 783.99] : [392.0, 311.13, 261.63];
    notes.forEach((f, i) => tone(f, t + i * 0.12, 0.28, 0.16, 'square'));
  }

  return {
    resume() { ensure(); },
    playClink,
    playSting,
    setMuted(m) { muted = !!m; },
    isMuted() { return muted; },
    dispose() { if (ctx) { try { ctx.close(); } catch { } ctx = null; } },
  };
}
