// pocabinet/environment.js
//
// Time-of-day + weather pass for PoCabinet's scene. Two layers on top of the
// static per-track atmosphere:
//
//   • night — handed to SceneHandle.setSkyEnvironment, which darkens fog and sky,
//     dims the sun and fill, re-captures the IBL and lights the lamps; race.js
//     switches the cars' headlights on from currentEnvironment().night
//   • rain  — a camera-attached LineSegments streak field (recycled in a small
//     box ahead of the player), fog pulled in, plus (solo races only) a grip
//     penalty race.js applies (online stays dry: prediction must run the server numbers)
//
// "auto" resolution:
//   • timeOfDay auto — the player's local clock (dawn/dusk ramps)
//   • weather auto   — one cached open-meteo.com fetch for Washington D.C.
//     (no API key, no geolocation prompt; the satire picks the capital).
//     Cached 30 minutes in localStorage; any failure resolves to clear.
//
// Both also feed the rest of the scene: the sky dome and the lamps / floodlit
// landmarks get the night factor (handle.setSkyEnvironment); rain turns the
// asphalt dark and near-mirror, puts drops on the camera lens (postfx.js via
// handle.fx.rain) and plays rain on the roof. The wiper clock still runs, but
// with the cockpit view retired nothing draws or plays the wiper.
//
// All mutations go through the SceneHandle from scene.js and are fully undone
// by dispose(), so a race teardown never leaks GPU resources.

import * as THREE from 'three';
import { currentSettings, loadSettings } from './settings.js';
import * as audio from './audio.js';

const WIPE_PERIOD = 1.8;

const ENV_CACHE_KEY = 'pocabinet.envcache.v1';
const ENV_CACHE_MS = 30 * 60 * 1000;

// open-meteo weather codes that mean "wet track" (drizzle/rain/showers/storm).
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);

let current = { night: 0, raining: false, source: 'default' };

/** Environment of the most recent mount — race.js reads this for solo rain grip. */
export function currentEnvironment() {
    return current;
}

/** Map the local clock to a 0 (noon) .. 1 (deep night) factor with dawn/dusk ramps. */
function nightFactorFromClock() {
    const h = new Date().getHours() + new Date().getMinutes() / 60;
    if (h >= 8 && h < 17) return 0;         // full day
    if (h >= 21 || h < 5) return 1;         // full night
    if (h >= 17) return (h - 17) / 4;       // 17:00 → 21:00 dusk ramp
    return 1 - (h - 5) / 3;                 // 05:00 → 08:00 dawn ramp
}

async function fetchCapitalRain() {
    try {
        const cached = window.localStorage.getItem(ENV_CACHE_KEY);
        if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed && typeof parsed.t === 'number' && Date.now() - parsed.t < ENV_CACHE_MS) {
                return { raining: !!parsed.raining, source: 'cache' };
            }
        }
    } catch { /* fall through to fetch */ }

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const res = await fetch(
            'https://api.open-meteo.com/v1/forecast?latitude=38.895&longitude=-77.0366&current=weather_code',
            { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`open-meteo ${res.status}`);
        const json = await res.json();
        const code = json?.current?.weather_code;
        const raining = RAIN_CODES.has(Number(code));
        try {
            window.localStorage.setItem(ENV_CACHE_KEY, JSON.stringify({ t: Date.now(), raining }));
        } catch { /* cache is best-effort */ }
        return { raining, source: 'open-meteo' };
    } catch {
        return { raining: false, source: 'offline' };
    }
}

/**
 * Resolve the environment for the current preferences. Never throws — a
 * failed resolution degrades to a clear midday scene.
 */
export async function resolveEnvironment() {
    // Load from storage first: the page reads/writes the settings JSON itself, so
    // until something calls loadSettings the module copy is still the defaults and
    // a saved day/night or weather choice would be ignored after a reload.
    loadSettings();
    const prefs = currentSettings();
    let night;
    if (prefs.timeOfDay === 'night') night = 1;
    else if (prefs.timeOfDay === 'day') night = 0;
    else night = nightFactorFromClock();

    let raining;
    let source;
    if (prefs.weather === 'rain') { raining = true; source = 'forced'; }
    else if (prefs.weather === 'clear') { raining = false; source = 'forced'; }
    else {
        const resolved = await fetchCapitalRain();
        raining = resolved.raining;
        source = resolved.source;
    }

    current = { night, raining, source };
    return current;
}

class EnvironmentHandle {
    constructor(sceneHandle, env) {
        this.sceneHandle = sceneHandle;
        this.env = env;
        this.disposed = false;
        this.applied = [];
        this.frameCb = null;
        this.rain = null;
        this.headlight = null;
        this.apply();
    }

    apply() {
        const handle = this.sceneHandle;
        if (!handle || handle.disposed) return;
        const prefs = currentSettings();
        const night = this.env.night;
        const raining = this.env.raining;

        handle.setSkyEnvironment?.(night, raining);
        this.applied.push(() => handle.setSkyEnvironment?.(0, false));

        // Night lighting, fog and the sky all come from setSkyEnvironment above; the
        // headlights ride the cars (race.js → cars.js), not the camera.

        // ── Rain: camera-parented streak field ──
        if (raining) {
            const count = prefs.reducedMotion ? 120 : 320;
            const positions = new Float32Array(count * 2 * 3);
            this.dropY = new Float32Array(count);
            for (let i = 0; i < count; i++) {
                const x = (Math.random() * 2 - 1) * 16;
                const y = Math.random() * 12;
                const z = -Math.random() * 26;
                this.dropY[i] = y;
                positions[i * 6 + 0] = x; positions[i * 6 + 1] = y; positions[i * 6 + 2] = z;
                positions[i * 6 + 3] = x; positions[i * 6 + 4] = y - 0.55; positions[i * 6 + 5] = z;
            }
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            const mat = new THREE.LineBasicMaterial({ color: 0x9db8d8, transparent: true, opacity: 0.42 });
            const group = new THREE.LineSegments(geom, mat);
            group.frustumCulled = false;
            handle.camera.add(group);
            this.rain = { geom, mat, group, count };
            this.applied.push(() => {
                handle.camera.remove(group);
                geom.dispose();
                mat.dispose();
            });

            // Wet asphalt: darker and near-mirror, so the sky, lamps and tail lights
            // reflect in it through the environment map (same PBR material, tuned).
            const road = handle.roadMesh;
            const roadMat = road?.material;
            if (roadMat && roadMat.isMeshStandardMaterial) {
                const dry = { color: roadMat.color.clone(), roughness: roadMat.roughness, env: roadMat.envMapIntensity, ns: roadMat.normalScale.clone() };
                roadMat.color.multiplyScalar(0.55);
                roadMat.roughness = 0.3;
                roadMat.envMapIntensity = 1.6;
                roadMat.normalScale.set(0.35, 0.35);
                this.applied.push(() => {
                    roadMat.color.copy(dry.color);
                    roadMat.roughness = dry.roughness;
                    roadMat.envMapIntensity = dry.env;
                    roadMat.normalScale.copy(dry.ns);
                });
            }

            if (handle.fx) {
                handle.fx.rain = 1;
                handle.fx.wipeP = WIPE_PERIOD;
                handle.fx.wipeT = 0;
                this.applied.push(() => { handle.fx.rain = 0; handle.fx.wipeT = 0; });
            }
            audio.setRain(1);
            this.applied.push(() => audio.setRain(0));

            let last = performance.now();
            let wipeT = 0;
            this.frameCb = (now) => {
                if (this.disposed || !this.rain) return;
                const dt = Math.min(0.05, (now - last) / 1000);
                last = now;
                // Wiper clock: the blade reverses at each half period — that is the thunk.
                const before = Math.floor(wipeT / (WIPE_PERIOD / 2));
                wipeT += dt;
                if (handle.fx) {
                    handle.fx.wipeT = wipeT;
                    if (Math.floor(wipeT / (WIPE_PERIOD / 2)) !== before) {
                        if (handle.fx.cockpit) audio.wiper();
                        // Re-assert: the AudioContext may only have been unlocked after mount.
                        audio.setRain(1);
                    }
                }
                const pos = this.rain.geom.attributes.position.array;
                const speed = prefs.reducedMotion ? 9 : 22;
                for (let i = 0; i < this.rain.count; i++) {
                    let y = this.dropY[i] - speed * dt;
                    if (y < -1) y += 12;
                    this.dropY[i] = y;
                    pos[i * 6 + 1] = y;
                    pos[i * 6 + 4] = y - 0.55;
                }
                this.rain.geom.attributes.position.needsUpdate = true;
            };
            handle.onFrame(this.frameCb);
        }
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        if (this.frameCb && this.sceneHandle) this.sceneHandle.offFrame(this.frameCb);
        for (const undo of this.applied) {
            try { undo(); } catch { /* teardown is best-effort */ }
        }
        this.applied = [];
        this.rain = null;
        this.headlight = null;
    }
}

/**
 * Resolve + apply the environment to a mounted scene handle.
 * Returns a handle with dispose(); call it on race teardown.
 */
export async function mountEnvironment(sceneHandle) {
    const env = await resolveEnvironment();
    return new EnvironmentHandle(sceneHandle, env);
}

export function unmountEnvironment(handle) {
    if (!handle) return;
    handle.dispose();
}
