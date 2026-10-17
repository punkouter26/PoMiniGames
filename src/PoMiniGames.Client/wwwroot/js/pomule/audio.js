// PoMule's sounds: square-wave blips in the manner of an 8-bit sound chip. All home-made
// (the short tune included).
//
// The blips are the 'pomule' scope in gameCues.js, so each one also carries its screen
// feel (a light shake on a meteor, sparks on a claim) and plays through the platform's one
// AudioContext and its sfx bus: the app's master mute, volume and compressor apply.
// Nothing here owns an AudioContext. The opening tune is plain notes on that same bus.
//
// Silent on demo and kiosk routes, where the shell mutes game audio; the feel stays.

const quiet = () => /\/demo|[?&]kiosk=/.test(location.pathname + location.search);

/** A blip from the cue table. `at` ({x, y}, viewport px) places its particle burst, if it has one. */
function cue(name, at, pitch) {
  try {
    window.PoCue?.fire('pomule', name, {
      silent: quiet(), pitch, fx: !!at, x: at?.x, y: at?.y,
    });
  } catch { /* audio is never fatal */ }
}

/** The shared sfx bus, or null when muted, on a quiet route, or without Web Audio. */
function sfxBus() {
  const bus = window.PoAudioBus;
  if (quiet() || !bus || bus.isMuted?.()) return null;
  try { return bus.busSync?.('sfx') ?? null; } catch { return null; }
}

/** One note. `to` slides the pitch there over the note's length. */
export function note(freq, seconds = 0.06, { type = 'square', volume = 0.04, to = null, delay = 0 } = {}) {
  const out = sfxBus();
  if (!out) return;
  const a = out.context;
  const t = a.currentTime + delay;
  const osc = a.createOscillator(), gain = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.linearRampToValueAtTime(to, t + seconds);
  gain.gain.setValueAtTime(volume, t);
  gain.gain.linearRampToValueAtTime(0, t + seconds);
  osc.connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + seconds + 0.02);
}

export const step = () => cue('step');
export const unit = (n = 0) => cue('unit', null, (330 + n * 40) / 330);
export const trade = () => cue('trade');
export const claim = (at) => cue('claim', at);
export const buy = () => cue('buy');
export const refuse = () => cue('refuse');
export const bray = () => cue('bray');
export const wampus = (at) => cue('wampus', at);
/** A meteor came down on the plot at `at`. */
export const meteor = (at) => cue('meteor', at);
/** The land auction's high bid moved. */
export const auctionTick = () => cue('auctionTick');

/** The pitch of a price on the trading floor: higher price, higher note. */
export const price = (fraction) => cue('price', null, (220 + 440 * Math.max(0, Math.min(1, fraction))) / 220);

/** A short opening fanfare, played when a match starts. A jingle, not background music. */
export function tune() {
  const melody = [392, 392, 523, 392, 659, 587, 523, 440, 523, 659, 784];
  melody.forEach((f, i) => note(f, 0.13, { delay: i * 0.14, volume: 0.05 }));
  [196, 196, 262, 262, 220, 220].forEach((f, i) => note(f, 0.26, { type: 'triangle', delay: i * 0.28, volume: 0.06 }));
}
