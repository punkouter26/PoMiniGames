// impactBus.js — the platform's shared "game feel" layer (§GFX-8).
//
// WHY THIS EXISTS
// Every game had its own idea of what a hit felt like, or no idea at all.
// PoBrawl shook its own canvas from inside its render loop; MarbleRace punched
// the FOV; ConnectFive did nothing. Nothing was shared, so nothing was
// consistent, and the DOM-only games (TicTacToe, the quizzes, PoJoker) had no
// route to any of it because they have no render loop to hook.
//
// One bus now owns the four channels that make an interaction feel physical:
//
//   TRAUMA   → screenshake. Trauma is a 0..1 reservoir that decays; the actual
//              offset is trauma² × noise. Squaring is the whole trick — it
//              makes a small hit read as a tap and a big one as an earthquake,
//              instead of everything reading as the same rattle.
//   PUNCH    → a 0..1 envelope for chromatic aberration / radial blur. Consumed
//              by the WebGL post stacks (PoBrawl, MarbleRace, PoRacer), which
//              read getPunch() each frame rather than tracking their own.
//   FLASH    → a full-screen tint spike, for KOs and eliminations.
//   HITSTOP  → a global time scale < 1 for a few dozen ms. Games multiply their
//              dt by getTimeScale(). Freezing the frame at the moment of impact
//              is the single cheapest way to make a hit land.
//
// HOW THE DOM SIDE APPLIES
// Shake writes to the CSS `translate` and `rotate` *properties*, not `transform`.
// That matters: they compose with whatever `transform` the component already has
// (a game board mid-flip, a card mid-pop) instead of clobbering it, so shaking a
// stage can never fight a component's own animation. Both are compositor-only.
//
// The loop only runs while something is actually decaying. An idle page costs
// zero — no rAF is scheduled at all.

const HAPTICS_KEY = 'pomini_haptics';

// Per-kind presets. Tuned so `light` is felt-but-not-noticed and `heavy` is
// unmistakable without being nauseating; anything above 0.7 trauma starts to
// read as a bug rather than a hit.
const PRESETS = {
    tick:   { trauma: 0.00, punch: 0.05, flash: 0.00, stopMs: 0,  haptic: [8] },
    select: { trauma: 0.05, punch: 0.10, flash: 0.00, stopMs: 0,  haptic: [10] },
    light:  { trauma: 0.16, punch: 0.18, flash: 0.04, stopMs: 25, haptic: [12] },
    medium: { trauma: 0.34, punch: 0.38, flash: 0.10, stopMs: 55, haptic: [18, 30, 12] },
    heavy:  { trauma: 0.62, punch: 0.72, flash: 0.22, stopMs: 90, haptic: [28, 40, 22] },
    win:    { trauma: 0.30, punch: 0.45, flash: 0.28, stopMs: 60, haptic: [20, 60, 20, 60, 40] },
    lose:   { trauma: 0.45, punch: 0.30, flash: 0.16, stopMs: 80, haptic: [90] },
};

// Decay rates, per second. Trauma outlives punch on purpose: the colour spike
// should be gone before the camera has finished settling, which is how a real
// impact reads (the flash is instantaneous, the shake rings out).
const TRAUMA_DECAY = 1.9;
const PUNCH_DECAY = 4.5;
const FLASH_DECAY = 6.0;

// Shake geometry at trauma = 1. Rotation is small relative to translation —
// a stage that spins reads as broken, one that jitters reads as struck.
const MAX_OFFSET_PX = 18;
const MAX_ROTATE_DEG = 1.1;

// Independent noise frequencies per axis so the motion never looks like a
// circle or a diagonal line. Prime-ish ratios keep the pattern from repeating
// inside the ~600 ms a shake actually lasts.
const FREQ_X = 13.7;
const FREQ_Y = 17.3;
const FREQ_R = 11.1;

let _trauma = 0;
let _punch = 0;
let _flash = 0;
let _timeScale = 1;
let _stopUntil = 0;

let _rafId = 0;
let _last = 0;
let _running = false;

let _flashEl = null;
/** @type {Set<HTMLElement>} */
const _stages = new Set();

const _root = typeof document !== 'undefined' ? document.documentElement : null;

/**
 * Motion sensitivity. Read live rather than cached: the Profile toggle and the
 * OS setting can both change mid-session, and a stale read would keep shaking
 * the screen for someone who just asked it to stop.
 */
function motionReduced() {
    try {
        if (_root && _root.getAttribute('data-motion') === 'reduce') return true;
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

/**
 * Global amplitude scale. Weak hardware gets less shake for the same reason it
 * gets less blur — the effect is the first thing to cost a frame, and a hitch
 * during a hit is worse than a smaller hit.
 */
function tierScale() {
    if (!_root) return 1;
    switch (_root.getAttribute('data-gfx')) {
        case 'low': return 0.35;
        case 'medium': return 0.7;
        default: return 1;
    }
}

/**
 * Deterministic smooth noise in -1..1. Two incommensurable sines beat a
 * Math.random() jitter here: random reads as static/tearing, this reads as
 * a body oscillating and settling.
 */
function noise(t, freq) {
    return Math.sin(t * freq) * 0.62 + Math.sin(t * freq * 2.37 + 1.7) * 0.38;
}

function ensureFlashLayer() {
    if (_flashEl || typeof document === 'undefined' || !document.body) return _flashEl;
    const el = document.createElement('div');
    el.className = 'po-impact-flash';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    _flashEl = el;
    return el;
}

function step(now) {
    if (!_running) return;
    // First frame after an idle period has no meaningful delta; clamp so a
    // backgrounded tab returning does not instantly decay everything to zero.
    const dt = _last ? Math.min((now - _last) / 1000, 0.05) : 0.016;
    _last = now;

    _trauma = Math.max(0, _trauma - TRAUMA_DECAY * dt);
    _punch = Math.max(0, _punch - PUNCH_DECAY * dt);
    _flash = Math.max(0, _flash - FLASH_DECAY * dt);
    _timeScale = now < _stopUntil ? 0.12 : 1;

    const shake = _trauma * _trauma * tierScale();
    const t = now / 1000;

    if (_stages.size) {
        const x = (noise(t, FREQ_X) * shake * MAX_OFFSET_PX).toFixed(2);
        const y = (noise(t, FREQ_Y) * shake * MAX_OFFSET_PX).toFixed(2);
        const r = (noise(t, FREQ_R) * shake * MAX_ROTATE_DEG).toFixed(3);
        for (const el of _stages) {
            // `translate`/`rotate` rather than `transform` — see header note.
            el.style.translate = `${x}px ${y}px`;
            el.style.rotate = `${r}deg`;
        }
    }

    if (_flashEl) _flashEl.style.opacity = _flash.toFixed(3);

    if (_root) {
        _root.style.setProperty('--po-punch', _punch.toFixed(3));
        _root.style.setProperty('--po-shake', shake.toFixed(3));
    }

    if (_trauma > 0.001 || _punch > 0.001 || _flash > 0.001 || _timeScale !== 1) {
        _rafId = requestAnimationFrame(step);
    } else {
        // Settle exactly on zero. Leaving a 0.0004px translate behind pins a
        // compositor layer on every registered stage for the rest of the session.
        for (const el of _stages) { el.style.translate = ''; el.style.rotate = ''; }
        if (_flashEl) _flashEl.style.opacity = '0';
        if (_root) {
            _root.style.setProperty('--po-punch', '0');
            _root.style.setProperty('--po-shake', '0');
        }
        _running = false;
        _rafId = 0;
    }
}

function ensureRunning() {
    if (_running || typeof requestAnimationFrame !== 'function') return;
    _running = true;
    _last = 0;
    _rafId = requestAnimationFrame(step);
}

/**
 * Register an element as a shake target. Usually the game's stage/canvas
 * wrapper rather than <body>, so fixed chrome (top bar, modals) stays still —
 * shaking the UI along with the playfield reads as a broken page.
 * @param {HTMLElement} el
 * @returns {() => void} unregister
 */
export function registerStage(el) {
    if (!el) return () => {};
    _stages.add(el);
    return () => unregisterStage(el);
}

export function unregisterStage(el) {
    if (!el) return;
    _stages.delete(el);
    el.style.translate = '';
    el.style.rotate = '';
}

/**
 * Fire an impact.
 * @param {'tick'|'select'|'light'|'medium'|'heavy'|'win'|'lose'} kind
 * @param {number} [scale=1] multiplier, for hits that vary continuously
 *   (damage dealt, collision speed). Clamped so a runaway value can't lock the
 *   screen into a permanent earthquake.
 */
export function impact(kind, scale) {
    const p = PRESETS[kind] || PRESETS.light;
    const s = Math.max(0, Math.min(2.5, scale == null ? 1 : scale));
    const reduced = motionReduced();

    // Trauma accumulates rather than overwrites, so a flurry of hits builds —
    // but it saturates at 1, so it can never run away.
    if (!reduced) _trauma = Math.min(1, _trauma + p.trauma * s);
    _punch = Math.min(1, _punch + p.punch * s * (reduced ? 0.35 : 1));
    _flash = Math.min(1, _flash + p.flash * s * (reduced ? 0.4 : 1));

    if (p.stopMs > 0 && !reduced) {
        const until = (typeof performance !== 'undefined' ? performance.now() : 0) + p.stopMs * Math.min(s, 1.5);
        if (until > _stopUntil) _stopUntil = until;
    }

    if (p.haptic) vibrate(p.haptic);
    ensureRunning();
}

/** Add trauma directly, for engines that already compute their own hit weight. */
export function addTrauma(amount) {
    if (motionReduced()) return;
    _trauma = Math.min(1, _trauma + Math.max(0, amount));
    ensureRunning();
}

/**
 * Freeze time for a moment. Callers must actually consult getTimeScale() in
 * their integration step — this sets the value, it cannot pause anyone's loop.
 */
export function hitstop(ms) {
    if (motionReduced()) return;
    const until = (typeof performance !== 'undefined' ? performance.now() : 0) + Math.max(0, ms);
    if (until > _stopUntil) _stopUntil = until;
    ensureRunning();
}

/** 0..1 aberration/blur envelope for the WebGL post stacks. */
export function getPunch() { return _punch; }

/** 0..1 shake magnitude, for engines that shake their own camera in 3D. */
export function getShake() { return _trauma * _trauma * tierScale(); }

/** Multiply your per-frame dt by this. 1 normally, ~0.12 during hitstop. */
export function getTimeScale() { return _timeScale; }

/**
 * Haptics. Gated on the Profile opt-out (mute is the wrong lever — "sound yes,
 * buzzing no" is the common case on a phone held in the hand) and on the same
 * reduced-motion preference that suppresses shake.
 * @param {number[]} pattern
 */
export function vibrate(pattern) {
    try {
        if (localStorage.getItem(HAPTICS_KEY) === '0') return;
        if (motionReduced()) return;
        // Bug fix (2026-08-07): kiosk/demo runs without a user gesture, so
        // every browser vibrate call below would emit a console error. Skip
        // the call entirely on any /{game}/demo or ?kiosk=N route — the
        // attract reel has no one to vibrate.
        if (isOnKioskRoute()) return;
        if (navigator && typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
    } catch { /* unsupported or storage blocked */ }
}

// Cheap URL probe — kiosk coordinator decides whether the reel is running
// but every demo also shares the same "no human in front of the screen" surface.
function isOnKioskRoute() {
    try {
        if ((location.search || '').indexOf('kiosk=') >= 0) return true;
        return /\/demo(\b|\/|$)/i.test(location.pathname || '');
    } catch {
        return false;
    }
}

/**
 * One-shot pop on an element — the HUD-number bump. Re-adding a class that is
 * already present does not restart a CSS animation, so the class is removed and
 * a reflow forced between; that is the only reliable cross-browser restart.
 * @param {HTMLElement} el
 */
export function pop(el) {
    if (!el || motionReduced()) return;
    el.classList.remove('fx-pop');
    void el.offsetWidth;
    el.classList.add('fx-pop');
}

/** Cancel everything immediately — used on game teardown and route change. */
export function reset() {
    _trauma = _punch = _flash = 0;
    _stopUntil = 0;
    _timeScale = 1;
    for (const el of _stages) { el.style.translate = ''; el.style.rotate = ''; }
    if (_flashEl) _flashEl.style.opacity = '0';
    if (_root) {
        _root.style.setProperty('--po-punch', '0');
        _root.style.setProperty('--po-shake', '0');
    }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureFlashLayer, { once: true });
    } else {
        ensureFlashLayer();
    }
    // A shake that survives a route change looks like a rendering bug. Blazor
    // does not fire a DOM event for navigation, so the stage set emptying on
    // dispose is the real guard; this covers full reloads and bfcache returns.
    window.addEventListener('pagehide', reset);
}

if (typeof window !== 'undefined') {
    // Non-module access for the game engines that are plain scripts
    // (racingInterop.js, posurvive/*, pojoker-*) and for Blazor JS interop,
    // which cannot import an ES module without a dynamic import per call.
    window.PoImpact = {
        impact, addTrauma, hitstop, getPunch, getShake, getTimeScale,
        registerStage, unregisterStage, vibrate, pop, reset,
    };
}
