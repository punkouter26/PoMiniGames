// pocabinet/practice.js
//
// Solo race ticker for the 1p / 2p / demo modes. The hub-driven multiplayer
// loop lives in C# (PoCabinetSession); this module is the small in-browser
// practice harness so the cockpit can be exercised end-to-end without a
// second browser. Bot cars roll on the same oval with personality-driven
// steering (loosely mirroring the server's PoCabinetAiDriver.Step). The
// local car is driven by keyboard intent captured from the canvas.
//
// Public surface (called from PoCabinet via window.PoCabinet.startSoloRace):
//   startSoloRace(dotnetRef, playerName, livery, color)
//   stopSoloRace()
//   pauseSoloRace() / resumeSoloRace()   — solo-only pause (Esc / HUD button)
//
// Solo countdown: a 3-2-1-GO gate runs before the first tick advances any car
// (snapshot.countdownSeconds carries it to the HUD, which renders the big
// number and pings the audio module on each transition).

import { officialName } from './dialogue.js';
import { currentEnvironment } from './environment.js';

const SOLO_KEY = 'pocabinet-solo-running';
const COUNTDOWN_SECONDS = 3.999;

const OFFICIALS = ['sean-s', 'steve-b', 'bill-b', 'mike-p'];

// Practice-only personas. Wire-mode multiplayer uses the server's
// PoCabinetAiDriver — practice is for one-player training/warm-up.
const PERSONAS = OFFICIALS.map((id, i) => ({
    id,
    color: i === 0 ? '#3470d8' : (i === 1 ? '#5e4b8b' : (i === 2 ? '#a02c2c' : '#1c8054')),
    colorDark: i === 0 ? '#1f3a78' : (i === 1 ? '#322761' : (i === 2 ? '#5b1717' : '#0e4d32')),
    lateralOffset: i === 0 ? -0.45 : (i === 1 ? 0.30 : (i === 2 ? -0.20 : 0.55)),
    maxSpeedKmh: 240 - i * 12,
    aggression: 0.55 + i * 0.08,
}));

const inputState = { up: false, down: false, left: false, right: false };
let keyHook = null;
let sceneTickRef = null;
let paused = false;

/** Begin a solo race against four official AI drivers. */
export function startSoloRace(dotnetRef, playerName, livery, color) {
    stopSoloRace();
    globalThis[SOLO_KEY] = true;
    paused = false;

    // Rain (resolved by environment.js) makes the solo surface slippery —
    // acceleration and steering both pay a grip tax. Multiplayer stays
    // server-authoritative and is untouched by this client-side effect.
    const grip = currentEnvironment().raining ? 0.85 : 1;

    const state = {
        startedAt: performance.now(),
        totalLaps: 3,
        elapsed: 0,
        finished: false,
        finishedAt: 0,
        countdown: COUNTDOWN_SECONDS,
        grip,
        // T11 (2026-09-17): best-lap for the player, tracked across completed
        // laps and reported to the leaderboard on finish.
        bestLapSeconds: Infinity,
        currentLapStart: 0,
        player: {
            id: 0,
            officialId: 'player',
            name: playerName || 'Player',
            color: color || '#3a7d44',
            colorDark: '#1f4626',
            x: 280, y: 0, heading: 0, speedKmh: 0,
            lap: 1, lapProgress: 0, position: 1,
            isPlayer: true, finished: false,
            lastAngle: 0,
        },
        bots: PERSONAS.map((p, i) => ({
            id: i + 1,
            officialId: p.id,
            name: officialName(p.id),
            color: p.color, colorDark: p.colorDark,
            x: 280 - 18, y: 15 - i * 8, heading: 0, speedKmh: 0,
            lap: 1, lapProgress: 0, position: 2 + i,
            isPlayer: false, finished: false,
            lateralOffset: p.lateralOffset,
            maxSpeedKmh: p.maxSpeedKmh,
            lastAngle: 0,
            phase: i * 1.7,
        })),
        rx: 280, ry: 180,
    };

    globalThis._pocabinetPracticeState = state;

    CaptureInput(dotnetRef);

    let last = performance.now();
    function tick(now) {
        if (!globalThis[SOLO_KEY]) return;
        const dt = paused ? 0 : Math.min(0.05, (now - last) / 1000);
        last = now;
        if (!paused) {
            state.elapsed += dt;
            if (state.countdown > 0) {
                // Pre-race gate: cars are held on the grid until 3-2-1-GO ends.
                state.countdown = Math.max(0, state.countdown - dt);
            } else {
                AdvanceCar(state, state.player, PlayerInput(), dt);
                state.bots.forEach(b => AdvanceCar(state, b, BotInput(state, b), dt));
                UpdateLapAndPosition(state);
            }
        }

        try { dotnetRef.invokeMethodAsync('OnSoloSnapshotAsync', BuildSnapshot(state)); } catch { /* disposed */ }

        if (state.finished && now - state.finishedAt > 5000) {
            stopSoloRace();
            return;
        }
        sceneTickRef = requestAnimationFrame(tick);
    }
    sceneTickRef = requestAnimationFrame(tick);
}

/** Freeze the solo ticker (pause menu). Snapshots stop; the loop idles. */
export function pauseSoloRace() {
    if (globalThis[SOLO_KEY]) paused = true;
}

/** Unfreeze. `last` was kept fresh by the idling loop, so dt resumes cleanly. */
export function resumeSoloRace() {
    paused = false;
}

export function stopSoloRace() {
    globalThis[SOLO_KEY] = false;
    paused = false;
    if (sceneTickRef) cancelAnimationFrame(sceneTickRef);
    sceneTickRef = null;
    if (keyHook) {
        document.removeEventListener('keydown', keyHook.onDown);
        document.removeEventListener('keyup', keyHook.onUp);
        keyHook = null;
    }
}

// ──────────────────────────────────────────────────────────────────────────

const CarRadius = 14;
const MaxSpeedKmh = 260;
const AccelKmhPerSec = 120;

function PlayerInput() {
    const throttle = inputState.up ? 1 : 0;
    const brake = inputState.down ? 1 : 0;
    let steer = 0;
    if (inputState.left) steer += 1;
    if (inputState.right) steer -= 1;
    return { throttle, brake, steer };
}

function BotInput(state, b) {
    return {
        throttle: 0.9,
        brake: 0,
        steer: Math.sin(state.elapsed * 0.5 + b.phase) * 0.45,
    };
}

function CaptureInput(dotnetRef) {
    const onDown = e => onKey(e, true, dotnetRef);
    const onUp = e => onKey(e, false, dotnetRef);
    document.addEventListener('keydown', onDown);
    document.addEventListener('keyup', onUp);
    keyHook = { onDown, onUp };
}

function onKey(e, down, dotnetRef) {
    const k = (e.key || '').toLowerCase();
    // Esc toggles the pause overlay (solo races only — this listener only
    // exists while a solo ticker runs; multiplayer stays unpausable).
    if (k === 'escape') {
        if (down) {
            e.preventDefault();
            try { dotnetRef.invokeMethodAsync('OnTogglePause'); } catch { /* disposed */ }
        }
        return;
    }
    if (k === 'w' || k === 'arrowup') inputState.up = down;
    else if (k === 's' || k === 'arrowdown') inputState.down = down;
    else if (k === 'a' || k === 'arrowleft') inputState.left = down;
    else if (k === 'd' || k === 'arrowright') inputState.right = down;
    else return;
    e.preventDefault();
    try { dotnetRef.invokeMethodAsync('OnInputAsync', inputState.up, inputState.down, inputState.left, inputState.right); } catch { /* disposed */ }
}

function AdvanceCar(state, car, input, dt) {
    const grip = state.grip || 1;
    if (input.throttle > 0) car.speedKmh = Math.min(MaxSpeedKmh, car.speedKmh + AccelKmhPerSec * dt * input.throttle * grip);
    if (input.brake > 0) car.speedKmh = Math.max(0, car.speedKmh - AccelKmhPerSec * dt * input.brake);
    car.heading += input.steer * dt * 0.9 * grip;

    const speedMS = car.speedKmh * (1000 / 3600);
    car.x += Math.cos(car.heading) * speedMS * dt;
    car.y += Math.sin(car.heading) * speedMS * dt;

    ConstrainToTrack(state, car);
    const angle = Math.atan2(car.y / state.ry, car.x / state.rx);
    const newProgress = (angle + Math.PI) / (2 * Math.PI);
    if (newProgress < 0.2 && (car.lastAngle ?? 0) > 0.8) {
        if (state.elapsed > 1) {
            car.lap += 1;
            // T11 (2026-09-17): only the player contributes a best lap; the
            // four AI officials are for atmosphere, not the leaderboard.
            if (car.isPlayer) {
                const lapTime = state.elapsed - state.currentLapStart;
                if (lapTime > 0 && lapTime < state.bestLapSeconds) state.bestLapSeconds = lapTime;
                state.currentLapStart = state.elapsed;
            }
        }
    }
    car.lastAngle = newProgress;
    car.lapProgress = newProgress;
}

/**
 * Soft walls: the practice harness has no collision pass, so a car that
 * leaves the ribbon is spring-nudged back toward the centerline and its
 * heading eased toward the track tangent. Keeps solo laps actually laps —
 * without this, holding W drives the player into the void and the sector
 * timing never sees a lap line again.
 */
function ConstrainToTrack(state, car) {
    const angle = Math.atan2(car.y / state.ry, car.x / state.rx);
    const cx = state.rx * Math.cos(angle);
    const cy = state.ry * Math.sin(angle);
    const dx = car.x - cx;
    const dy = car.y - cy;
    const dist = Math.hypot(dx, dy);
    const maxDist = 30; // roughly half the ribbon width in server units
    if (dist > maxDist) {
        const pull = (dist - maxDist) * 0.22;
        car.x -= (dx / dist) * pull;
        car.y -= (dy / dist) * pull;
        // Ease the heading toward the ellipse tangent (t = angle + π/2).
        const tangent = angle + Math.PI / 2;
        let delta = tangent - car.heading;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        car.heading += delta * 0.14;
    }
}

function UpdateLapAndPosition(state) {
    const all = [state.player, ...state.bots];
    all.sort((a, b) => a.lap === b.lap ? b.lapProgress - a.lapProgress : b.lap - a.lap);
    all.forEach((c, i) => c.position = i + 1);
    if (Math.max(...all.map(c => c.lap)) > state.totalLaps && !state.finished) {
        state.finished = true;
        state.finishedAt = performance.now();
    }
}

function BuildSnapshot(state) {
    // T11 (2026-09-17): bestLap is a Number-or-null on the wire so System.Text.Json
    // happily deserialises an unset value as null instead of an awkward Infinity.
    const bestLap = Number.isFinite(state.bestLapSeconds) ? state.bestLapSeconds : null;
    return {
        gameCode: 'SOLO',
        serverTimeMs: Date.now(),
        elapsedRaceTime: state.elapsed,
        started: state.countdown <= 0,
        countdownSeconds: Math.ceil(state.countdown),
        finished: state.finished,
        localCarId: state.player.id,
        cars: [state.player, ...state.bots],
        latestDialogue: null,
        static: null,
        bestLapSeconds: bestLap,
    };
}
