// PoMule's sounds: square-wave blips in the manner of an 8-bit sound chip. All home-made
// (the short tune included). Silent while the app's master mute is on, and on demo routes
// where the shell mutes game audio.

let ac = null;

function context() {
  if (window.AudioBus?.isMuted?.()) return null;
  if (/\/demo|[?&]kiosk=/.test(location.pathname + location.search)) return null;
  try {
    ac ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    return ac;
  } catch {
    return null;
  }
}

/** One note. `to` slides the pitch there over the note's length. */
export function note(freq, seconds = 0.06, { type = 'square', volume = 0.04, to = null, delay = 0 } = {}) {
  const a = context();
  if (!a) return;
  const t = a.currentTime + delay;
  const osc = a.createOscillator(), gain = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.linearRampToValueAtTime(to, t + seconds);
  gain.gain.setValueAtTime(volume, t);
  gain.gain.linearRampToValueAtTime(0, t + seconds);
  osc.connect(gain).connect(a.destination);
  osc.start(t);
  osc.stop(t + seconds + 0.02);
}

export const step = () => note(110, 0.025, { volume: 0.02 });
export const unit = (n = 0) => note(330 + n * 40, 0.05);
export const trade = () => { note(660, 0.05); note(880, 0.07, { delay: 0.05 }); };
export const claim = () => { note(440, 0.08); note(660, 0.12, { delay: 0.08 }); };
export const buy = () => note(520, 0.1, { to: 780 });
export const refuse = () => note(160, 0.18, { type: 'sawtooth' });
export const bray = () => { note(620, 0.22, { type: 'sawtooth', to: 240 }); note(520, 0.3, { type: 'sawtooth', to: 140, delay: 0.24 }); };
export const wampus = () => { for (let i = 0; i < 5; i++) note(500 + i * 120, 0.06, { delay: i * 0.06 }); };

/** The pitch of a price on the trading floor: higher price, higher note. */
export const price = (fraction) => note(220 + 440 * Math.max(0, Math.min(1, fraction)), 0.03, { volume: 0.025 });

/** A short opening fanfare, played when a match starts. */
export function tune() {
  const melody = [392, 392, 523, 392, 659, 587, 523, 440, 523, 659, 784];
  melody.forEach((f, i) => note(f, 0.13, { delay: i * 0.14, volume: 0.05 }));
  [196, 196, 262, 262, 220, 220].forEach((f, i) => note(f, 0.26, { type: 'triangle', delay: i * 0.28, volume: 0.06 }));
}
