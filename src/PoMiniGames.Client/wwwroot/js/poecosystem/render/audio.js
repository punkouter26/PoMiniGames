// audio.js — procedural ambience, positional SFX and event stingers. No asset files, no
// dependencies: every layer is synthesised from a shared noise buffer and a handful of
// oscillators, so the bundle pays nothing for the "island is alive" feel. The AudioContext
// is created lazily on the first user gesture (browsers block autoplay), and every entry
// point is defensive — a blocked or broken audio device must never take the game down.
//
// Layers: constant wind and waves; birdsong by day; crickets by night (crossfaded by the
// sim's dayFraction, the same curve lighting.js uses). Stingers: lightning, rockslide,
// eruption. The HUD's sound pill toggles the master gain.
//
// GFX option 3 made all of that POSITIONAL. Before it, an eruption on the far shore was
// exactly as loud, as bright and as central as one at the player's feet:
//
//   LISTENER   the AudioContext listener is parked on the camera every frame, so panning
//              and distance are computed against where the god actually is.
//   PANNERS    every stinger and impact goes through a PannerNode with an inverse-distance
//              model, so the island has a near field and a far field.
//   SPEED OF   thunder is scheduled at `dist / 343` seconds after the flash, and its
//   SOUND      low-pass opens or closes with distance — air eats the high frequencies, and
//              that is the cue the ear actually uses to judge how far away a storm is.
//   REVERB     one synthesised impulse response (decaying noise — still no assets) on a
//              send, so a rockslide in the mountains rings and a footfall on the beach
//              does not.
//
// WHY ITS OWN AudioContext AND NOT PoAudioBus
// The app-wide bus is a fine mixer but it is a different AudioContext with a listener
// parked at the origin, and PoMaterialAudio's positioning is a stereo pan in screen space.
// Neither can express "that tree fell 60 metres behind you and to the left" in world
// coordinates. What the shared stack IS consulted for is mute: if the player has muted the
// app, this context follows it (see syncGlobalMute).
const MASTER_LEVEL = 0.55;
const SPEED_OF_SOUND = 343;      // m/s — the delay that makes distance legible
const MAX_AUDIBLE = 260;         // metres; past this a stinger is not scheduled at all

// Impact voices. Deliberately parallel to the app's materialAudio.js recipes so the island
// sounds like the rest of the platform, but re-synthesised here because they have to be
// born inside this context to be positioned in world space.
const MATERIALS = {
  wood: { thump: 95, decay: 0.16, noiseHz: 420, noiseQ: 1.2, noiseSec: 0.09 },
  stone: { thump: 55, decay: 0.13, noiseHz: 260, noiseQ: 0.8, noiseSec: 0.11 },
  flesh: { thump: 68, decay: 0.10, noiseHz: 180, noiseQ: 1.6, noiseSec: 0.07 },
  water: { thump: 0, decay: 0.20, noiseHz: 900, noiseQ: 0.9, noiseSec: 0.22 },
};

export function createAudio() {
  let ctx = null;
  let master = null;         // everything, dry
  let reverbSend = null;     // the wet path's input
  let birdGain = null;
  let cricketGain = null;
  let windGain = null;
  let noise = null;          // shared 2 s looped buffer
  let enabled = true;
  let lastChirpAt = 0;
  let lastImpactAt = 0;
  const listener = { x: 0, y: 0, z: 0 };

  const smooth = (v) => v * v * (3 - 2 * v);   // smoothstep for gain crossfades

  function ensure() {
    if (typeof window === 'undefined' || ctx) return;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    try { ctx = new Ctor(); } catch { ctx = null; return; }
    try { build(); } catch { ctx = null; }     // a broken device disables audio, not the game
  }

  /**
   * A decaying-noise impulse response. Two decorrelated channels give the tail width; the
   * exponent sets how "stone" the space is. Still no asset files — this is ~2 s of
   * Math.random through an envelope, generated once.
   */
  function makeImpulse(seconds, decay) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // An early-reflection gap keeps it from sounding like a plain noise swell.
        const gate = t < 0.012 ? t / 0.012 : 1;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * gate;
      }
    }
    return buf;
  }

  function build() {
    master = ctx.createGain();
    master.gain.value = enabled ? MASTER_LEVEL : 0;
    // A gentle limiter: an eruption stinger over a full dawn chorus can otherwise clip,
    // and clipping is the one artefact that makes synthesised audio sound cheap.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8; limiter.knee.value = 6; limiter.ratio.value = 6;
    limiter.attack.value = 0.004; limiter.release.value = 0.18;
    master.connect(limiter).connect(ctx.destination);

    const convolver = ctx.createConvolver();
    convolver.buffer = makeImpulse(2.4, 2.6);
    reverbSend = ctx.createGain();
    reverbSend.gain.value = 1;
    const wet = ctx.createGain();
    wet.gain.value = 0.34;
    reverbSend.connect(convolver).connect(wet).connect(master);

    // One pink-ish noise buffer feeds wind, waves and the stingers.
    const len = Math.floor(ctx.sampleRate * 2);
    noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noise.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + 0.029 * w; b1 = 0.985 * b1 + 0.032 * w; b2 = 0.95 * b2 + 0.048 * w;
      d[i] = (b0 + b1 + b2 + w * 0.05) * 0.9;
    }

    // Wind: looped noise through a slowly wandering low-pass. Kept non-positional on
    // purpose — wind has no source, and panning it would make the god's own head the
    // weather. Its LEVEL does move, with altitude (see setPlayer).
    const wind = loopNoise();
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass'; windFilter.frequency.value = 320; windFilter.Q.value = 0.4;
    windGain = ctx.createGain(); windGain.gain.value = 0.05;
    const windLfo = ctx.createOscillator(); windLfo.frequency.value = 0.07;
    const windDepth = ctx.createGain(); windDepth.gain.value = 140;
    windLfo.connect(windDepth).connect(windFilter.frequency);
    wind.connect(windFilter).connect(windGain).connect(master);
    wind.start(); windLfo.start();

    // Waves: the same noise through a band-pass, swelling and receding.
    const surf = loopNoise();
    const surfFilter = ctx.createBiquadFilter();
    surfFilter.type = 'bandpass'; surfFilter.frequency.value = 560; surfFilter.Q.value = 0.7;
    const surfGain = ctx.createGain(); surfGain.gain.value = 0.04;
    const surfLfo = ctx.createOscillator(); surfLfo.frequency.value = 0.13;
    const surfDepth = ctx.createGain(); surfDepth.gain.value = 0.02;
    surfLfo.connect(surfDepth).connect(surfGain.gain);
    surf.connect(surfFilter).connect(surfGain).connect(master);
    surf.start(); surfLfo.start();

    // Birds: silent bus; chirps are scheduled on top of it while the sun is up.
    birdGain = ctx.createGain(); birdGain.gain.value = 0;
    birdGain.connect(master);
    birdGain.connect(reverbSend);

    // Crickets: a high triangle tone, amplitude-modulated ~26 Hz, faded in at night.
    const cricket = ctx.createOscillator();
    cricket.type = 'triangle'; cricket.frequency.value = 4300;
    const am = ctx.createGain(); am.gain.value = 0.5;
    const amLfo = ctx.createOscillator(); amLfo.frequency.value = 26;
    const amDepth = ctx.createGain(); amDepth.gain.value = 0.5;
    amLfo.connect(amDepth).connect(am.gain);
    cricketGain = ctx.createGain(); cricketGain.gain.value = 0;
    cricket.connect(am).connect(cricketGain).connect(master);
    cricket.start(); amLfo.start();
  }

  function loopNoise() {
    const src = ctx.createBufferSource();
    src.buffer = noise; src.loop = true;
    return src;
  }

  /**
   * A positioned output node. Everything world-placed goes through one of these, so the
   * decision "how loud, how panned, how wet" is made once rather than per voice.
   * Returns null when the source is too far to be worth scheduling at all.
   */
  function place(x, y, z, { hrtf = false, wet = 0.25, ref = 8, rolloff = 1.15 } = {}) {
    const dist = Math.hypot(x - listener.x, y - listener.y, z - listener.z);
    if (dist > MAX_AUDIBLE) return null;
    const panner = ctx.createPanner();
    // HRTF for the rare dramatic one-shot, equal-power for the frequent ones: HRTF is a
    // convolution per source and a rockslide can fire a dozen impacts in a second.
    panner.panningModel = hrtf ? 'HRTF' : 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = ref;
    panner.maxDistance = MAX_AUDIBLE;
    panner.rolloffFactor = rolloff;
    if (panner.positionX) { panner.positionX.value = x; panner.positionY.value = y; panner.positionZ.value = z; }
    else panner.setPosition(x, y, z);
    panner.connect(master);
    if (wet > 0 && reverbSend) {
      const send = ctx.createGain();
      send.gain.value = wet;
      panner.connect(send).connect(reverbSend);
    }
    return { node: panner, dist };
  }

  function chirp(at) {
    const notes = 2 + Math.floor(Math.random() * 3);
    for (let k = 0; k < notes; k++) {
      const t = at + k * (0.14 + Math.random() * 0.06);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const f = 2200 + Math.random() * 1200;
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * 1.4, t + 0.05);
      osc.frequency.exponentialRampToValueAtTime(f * 0.9, t + 0.11);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
      osc.connect(g).connect(birdGain);
      osc.start(t); osc.stop(t + 0.16);
    }
  }

  /** dayFraction 0..1 (0 = midnight) — same curve lighting.js draws the sky with. */
  function setDay(dayFraction) {
    if (!ctx) return;
    syncGlobalMute();
    const day = Math.max(0, Math.sin((dayFraction - 0.25) * Math.PI * 2));
    const t = ctx.currentTime;
    birdGain?.gain.setTargetAtTime(smooth(day) * 0.9, t, 0.5);
    cricketGain?.gain.setTargetAtTime(smooth(1 - day) * 0.035, t, 0.5);
    if (day > 0.3 && t - lastChirpAt > 2.5 + Math.random() * 5) { lastChirpAt = t; chirp(t + 0.05); }
  }

  // The app-wide mixer owns the player's mute preference; this context is not on it, so it
  // has to ask. Polled at the 2 Hz stats cadence rather than subscribed: PoAudioBus exposes
  // no change event, and a boolean read twice a second costs nothing.
  let lastGlobalMute = false;
  function syncGlobalMute() {
    const muted = window.PoAudioBus?.isMuted?.() === true;
    if (muted === lastGlobalMute) return;
    lastGlobalMute = muted;
    applyMasterGain();
  }

  function applyMasterGain() {
    if (!ctx || !master) return;
    const on = enabled && !lastGlobalMute;
    master.gain.setTargetAtTime(on ? MASTER_LEVEL : 0, ctx.currentTime, 0.05);
  }

  /** Noise burst shaped by `filter`; the shared skeleton of every stinger. */
  function burst(dest, when, { type = 'lowpass', frequency = 200, Q = 0.7, level = 0.4, attack = 0.01, seconds = 1 }) {
    const src = ctx.createBufferSource();
    src.buffer = noise; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = frequency; f.Q.value = Q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(level, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + seconds);
    src.connect(f).connect(g).connect(dest);
    src.start(when); src.stop(when + seconds + 0.1);
  }

  function thump(dest, when, from, to, seconds, level) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(from, when);
    osc.frequency.exponentialRampToValueAtTime(to, when + seconds);
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + seconds);
    osc.connect(g).connect(dest);
    osc.start(when); osc.stop(when + seconds + 0.1);
  }

  /**
   * @param {string} kind 'lightning' | 'rockslide' | 'eruption'
   * @param {{x:number,y:number,z:number}} [at] world position; omitted, it plays centred
   *   and undelayed (the old behaviour, kept for callers that have no position).
   */
  function stinger(kind, at) {
    ensure();
    if (!ctx || !enabled) return;
    try {
      const placed = at ? place(at.x, at.y, at.z, { hrtf: true, wet: kind === 'rockslide' ? 0.5 : 0.35, ref: 14, rolloff: 0.9 }) : null;
      if (at && !placed) return;              // out of earshot entirely
      const dest = placed ? placed.node : master;
      const dist = placed ? placed.dist : 0;
      // The whole event is pushed back by its travel time. This is the single change that
      // makes a far-off storm read as far off rather than as a quieter near one.
      const when = ctx.currentTime + dist / SPEED_OF_SOUND;
      // Air absorbs treble with distance: a 200 m strike is a rumble, a 20 m strike cracks.
      const air = Math.max(0.12, 1 - dist / MAX_AUDIBLE);

      if (kind === 'lightning') {
        burst(dest, when, { type: 'highpass', frequency: 400 + 1000 * air, level: 0.5 * (0.4 + air * 0.6), seconds: 0.25 + (1 - air) * 0.6 });
        thump(dest, when + 0.02, 170, 55, 0.5 + (1 - air) * 1.6, 0.35);
      } else if (kind === 'rockslide') {
        burst(dest, when, { type: 'bandpass', frequency: 120 + 200 * air, Q: 0.7, level: 0.35, seconds: 1.3 });
      } else if (kind === 'eruption') {
        burst(dest, when, { type: 'lowpass', frequency: 70 + 60 * air, level: 0.5, attack: 0.08, seconds: 2.8 });
        thump(dest, when, 60, 40, 2.2, 0.25);
      }
    } catch { /* audio is best-effort */ }
  }

  /**
   * A positioned material impact — a log landing, a boulder settling, a body falling.
   * Driven by the renderer's prop-velocity watcher, which is why it is rate-limited here:
   * a rockslide can produce a dozen landings inside one frame and the ear wants a clatter,
   * not a wall.
   */
  function impact(material, x, y, z, intensity = 0.6) {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime;
    if (now - lastImpactAt < 0.035) return;
    lastImpactAt = now;
    try {
      const placed = place(x, y, z, { wet: 0.3, ref: 6, rolloff: 1.4 });
      if (!placed) return;
      const v = MATERIALS[material] ?? MATERIALS.wood;
      const i = Math.max(0.08, Math.min(1, intensity));
      const when = now + placed.dist / SPEED_OF_SOUND;
      const bus = ctx.createGain();
      bus.gain.value = 0.5 * i;
      bus.connect(placed.node);
      if (v.thump > 0) thump(bus, when, v.thump * (0.9 + i * 0.2), Math.max(28, v.thump * 0.55), v.decay, 1);
      burst(bus, when, { type: 'bandpass', frequency: v.noiseHz, Q: v.noiseQ, level: 0.9, attack: 0.002, seconds: v.noiseSec });
    } catch { /* audio is best-effort */ }
  }

  /**
   * Park the listener on the camera. Called every frame by the renderer — the WebAudio
   * listener has no interpolation of its own, so anything less than per-frame makes fast
   * flight sound like it is stepping.
   */
  function setPlayer(pose, dir) {
    if (!ctx) return;
    listener.x = pose.x; listener.y = pose.y; listener.z = pose.z;
    const l = ctx.listener;
    try {
      if (l.positionX) {
        const t = ctx.currentTime;
        // A short ramp rather than a jump: an instantaneous listener move produces an
        // audible click on every panner feeding it.
        l.positionX.setTargetAtTime(pose.x, t, 0.02);
        l.positionY.setTargetAtTime(pose.y, t, 0.02);
        l.positionZ.setTargetAtTime(pose.z, t, 0.02);
        l.forwardX.setTargetAtTime(dir.x, t, 0.02);
        l.forwardY.setTargetAtTime(dir.y, t, 0.02);
        l.forwardZ.setTargetAtTime(dir.z, t, 0.02);
        l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
      } else {
        l.setPosition(pose.x, pose.y, pose.z);
        l.setOrientation(dir.x, dir.y, dir.z, 0, 1, 0);
      }
    } catch { /* older engines expose one path or the other, never neither */ }

    // Altitude is the one thing the wind should answer to: a god at 80 m is in it.
    if (windGain) {
      const high = Math.min(1, Math.max(0, (pose.y - 6) / 70));
      windGain.gain.setTargetAtTime(0.05 + high * 0.13, ctx.currentTime, 0.6);
    }
  }

  return {
    ensure,
    setDay,
    stinger,
    impact,
    setPlayer,
    /** music.js builds its own graph on this context and mixes into the same master. */
    get context() { return ctx; },
    get musicDestination() { return master; },
    setEnabled(on) {
      enabled = !!on;
      applyMasterGain();
    },
    get enabled() { return enabled; },
    dispose() { try { ctx?.close(); } catch { /* already gone */ } ctx = null; master = null; reverbSend = null; },
  };
}
