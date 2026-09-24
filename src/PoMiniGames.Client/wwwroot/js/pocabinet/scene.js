// pocabinet/scene.js
//
// Three.js scene for PoCabinet. Owns the renderer, camera, fog, lights and the
// static track meshes, all built from the static world the page hands over
// (PoCabinetTrackGeometry.BuildStaticWorld — the same centerline the physics
// runs on, client and server):
//   • ground plane sized to the track bounds, tinted atmosphere.groundHex
//   • asphalt road ribbon (atmosphere.roadHex), TrackWidth wide
//   • low barriers at the run-off edge (atmosphere.accentHex) — exactly where
//     physics.js stops a car
//   • a chequered start line at distance 0
//   • an optional racing-line overlay coloured by corner speed (assist)
//
// World mapping: sim (x, y) → three (x / 10, 0, y / 10). Everything that places
// objects (cars.js, the camera helpers below) uses that one rule.
//
// Camera modes: 'cockpit' (the live default — the cockpit group rides the
// camera), 'chase' (behind and above a car) and 'tv' (a trackside camera that
// hands off along the lap). The camera is added to the scene graph so its
// children — cockpit, headlight, rain field — actually render; before
// 2026-09-23 it was not, and none of them ever appeared.
//
// Around the road: a sky dome (sky.js), trackside scenery with apex kerbs, the
// start gantry, lamps, landmarks and the press pen (scenery.js), and one
// post-processing pass (postfx.js) for speed blur, windscreen rain and the
// flash / slow-motion grade. `handle.fx` is the per-frame bag race.js and
// environment.js write into: speed, cockpit, rain, wiper clock, flash, shake,
// kerb rumble, slow motion. The loop turns it into FOV kick and camera shake
// after every frame callback has placed the camera.
//
// API surface:
//   const handle = await mount(canvas, world);
//   handle.setView({ x, y, heading, mode, speed }); handle.setRacingLine(bool);
//   handle.setStartLights(lit, go); handle.setSkyEnvironment(night, rain);
//   unmount(handle);

import * as THREE from 'three';
import { buildTrack } from './track.js';
import { RUN_OFF, GRIP_ACCEL } from './physics.js';
import { computeKerbs } from './kerbs.js';
import { Sky } from './sky.js';
import { Scenery } from './scenery.js';
import { PostFx } from './postfx.js';

export const WORLD_SCALE = 10;
const EYE_HEIGHT = 1.35;

function hex(value, fallback) {
    try { return new THREE.Color(value || fallback); } catch { return new THREE.Color(fallback); }
}

class SceneHandle {
    constructor(renderer, scene, camera, ambient, sun, canvas) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;
        this.ambient = ambient;
        this.sun = sun;
        this.canvas = canvas;
        this.disposed = false;
        this.track = null;
        this.trackGroup = null;
        this.racingLine = null;
        this.groundMesh = null;
        this.roadMesh = null;
        this.sky = null;
        this.scenery = null;
        this.post = null;
        this.baseFov = camera.fov;
        // Per-frame effect inputs (see header). Writers set values; the loop decays
        // flash and shake itself.
        this.fx = {
            speed: 0, cockpit: true, rain: 0, wipeT: 0, wipeP: 1.8, flash: 0, slow: 0,
            shake: 0, rumble: 0, reduced: false, focus: null,
        };
        // Atmosphere the track was mounted with (unmodified) — environment.js
        // derives night/rain lighting from this baseline.
        this.baseAtmosphere = null;
        this._frameCbs = new Set();
        this._raf = null;
        this._lastNow = null;
        this._tvIndex = -1;
        this._chase = new THREE.Vector3();
        this._chaseInit = false;
        this._onResize = () => this.resize();
        window.addEventListener('resize', this._onResize);
    }

    /** Register a per-frame callback (receives a DOMHighResTimeStamp). */
    onFrame(cb) {
        if (!this.disposed && typeof cb === 'function') this._frameCbs.add(cb);
    }

    offFrame(cb) {
        this._frameCbs.delete(cb);
    }

    startLoop() {
        if (this._raf !== null) return;
        const loop = (now) => {
            if (this.disposed) return;
            this._raf = requestAnimationFrame(loop);
            const dt = this._lastNow === null ? 0 : Math.min(0.1, (now - this._lastNow) / 1000);
            this._lastNow = now;
            for (const cb of this._frameCbs) {
                try { cb(now); } catch { /* one bad effect never kills the frame */ }
            }
            try {
                this.applyFx(dt);
                this.sky?.update(this.camera, this.scene.fog, now / 1000);
                this.scenery?.update(dt, this.fx.focus);
            } catch { /* decoration never kills the frame */ }
            if (this.post) this.post.render(this.scene, this.camera, this.fx, now / 1000);
            else this.renderer.render(this.scene, this.camera);
        };
        this._raf = requestAnimationFrame(loop);
    }

    stopLoop() {
        if (this._raf !== null) {
            cancelAnimationFrame(this._raf);
            this._raf = null;
        }
    }

    /**
     * Place the camera for a car pose. mode: 'cockpit' | 'chase' | 'tv'.
     * Car forward = (cos h, 0, sin h); the camera looks down -Z by default, so
     * yaw = -h - π/2 lines the view up with the car (cars.js convention).
     */
    setView(p) {
        if (this.disposed || !p) return;
        const x = (Number(p.x) || 0) / WORLD_SCALE;
        const z = (Number(p.y) || 0) / WORLD_SCALE;
        const heading = Number(p.heading) || 0;
        const mode = p.mode || 'cockpit';
        if (mode === 'cockpit') {
            this._chaseInit = false;
            this.camera.position.set(x, EYE_HEIGHT, z);
            this.camera.rotation.set(0, -heading - Math.PI / 2, 0);
            return;
        }
        if (mode === 'chase') {
            const back = 9, up = 3.6;
            const target = new THREE.Vector3(x - Math.cos(heading) * back, up, z - Math.sin(heading) * back);
            // Lagged follow so the car swings in frame through corners; time-based so the
            // lag is the same at 30 fps as at 144.
            const k = Number(p.dt) > 0 ? 1 - Math.exp(-Number(p.dt) * 10) : 0.18;
            if (!this._chaseInit || p.snap) { this._chase.copy(target); this._chaseInit = true; }
            else this._chase.lerp(target, k);
            this.camera.position.copy(this._chase);
            this.camera.lookAt(x + Math.cos(heading) * 3, 0.8, z + Math.sin(heading) * 3);
            return;
        }
        // TV: fixed trackside cameras every eighth of the lap, handing off as the car passes.
        const t = this.track;
        if (!t) return;
        const along = Number(p.along) || 0;
        const idx = Math.floor(((along % t.length) + t.length) % t.length / (t.length / 8) + 0.5) % 8;
        if (idx !== this._tvIndex || !this._tvPos) {
            this._tvIndex = idx;
            const q = t.pointAt(idx * (t.length / 8) + 40);
            const side = t.halfWidth + RUN_OFF + 30;
            this._tvPos = new THREE.Vector3((q.x - q.ty * side) / WORLD_SCALE, 7, (q.y + q.tx * side) / WORLD_SCALE);
        }
        this.camera.position.copy(this._tvPos);
        this.camera.lookAt(x, 0.6, z);
    }

    /**
     * Speed FOV kick + camera shake, applied after setView has placed the camera
     * for this frame (setView fully re-places it next frame, so nothing accumulates).
     */
    applyFx(dt) {
        const fx = this.fx;
        const motion = !fx.reduced;
        const fov = this.baseFov + (motion ? Math.pow(Math.min(1, fx.speed), 1.6) * 9 : 0);
        const k = dt > 0 ? 1 - Math.exp(-dt * 4) : 1;
        const next = this.camera.fov + (fov - this.camera.fov) * k;
        if (Math.abs(next - this.camera.fov) > 0.01) {
            this.camera.fov = next;
            this.camera.updateProjectionMatrix();
        }
        const amp = motion ? Math.min(1, fx.shake + fx.rumble * 0.35) : 0;
        if (amp > 0.002) {
            const r = () => Math.random() - 0.5;
            this.camera.position.x += r() * 0.05 * amp;
            this.camera.position.y += r() * 0.07 * amp;
            this.camera.rotateX(r() * 0.012 * amp);
            this.camera.rotateZ(r() * 0.016 * amp);
        }
        const decay = dt > 0 ? Math.exp(-dt * 7) : 1;
        fx.shake *= decay;
        fx.flash *= dt > 0 ? Math.exp(-dt * 4.5) : 1;
        if (fx.flash < 0.004) fx.flash = 0;
    }

    /** Start gantry: `lit` pods red (0..5), or all green on `go`. */
    setStartLights(lit, go) {
        this.scenery?.setStartLights(lit, go);
    }

    /** Night factor 0..1 and rain flag for the sky, lamps and floodlit landmarks. */
    setSkyEnvironment(night, rain) {
        this.sky?.setEnvironment(night, rain);
        this.scenery?.setNight(night);
    }

    /** Legacy cockpit follow (kept for callers that only have a pose). */
    updatePlayerView(p) {
        this.setView({ ...p, mode: 'cockpit' });
    }

    /** Apply player view preferences — pixel-ratio cap multiplier + FOV. */
    applyView(opts) {
        if (this.disposed) return;
        const o = opts && typeof opts === 'object' ? opts : {};
        const scale = Math.min(1.5, Math.max(0.5, Number(o.renderScale) || 1));
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * scale);
        const fov = Math.min(90, Math.max(60, Number(o.fov) || 70));
        this.baseFov = fov;
        if (Math.abs(this.camera.fov - fov) > 0.01) {
            this.camera.fov = fov;
            this.camera.updateProjectionMatrix();
        }
        this.fx.reduced = !!o.reducedMotion;
        this.setRacingLine(!!o.racingLine);
        this.resize();
    }

    /** Show or hide the racing-line assist overlay. */
    setRacingLine(visible) {
        if (this.racingLine) this.racingLine.visible = !!visible;
    }

    /** Build (or rebuild) every track mesh for a static world. */
    setTrack(world) {
        if (this.disposed) return;
        const atmosphere = world.atmosphere || {};
        this.baseAtmosphere = { ...atmosphere };
        this.scene.background = hex(atmosphere.skyHex, '#14233f');
        this.scene.fog = new THREE.Fog(hex(atmosphere.fogHex, '#14233f').getHex(),
            Number(atmosphere.fogStart) || 220, Number(atmosphere.fogEnd) || 900);
        this.ambient.intensity = Number(atmosphere.ambientIntensity) || 0.5;
        this.sun.intensity = Math.max(0.3, this.ambient.intensity + 0.2);

        this.disposeTrackMeshes();
        this.track = buildTrack(world);
        const group = new THREE.Group();
        group.name = 'pocabinet-track';

        // Ground: reaches past the fog's far edge in every direction, so it fades into
        // the sky dome's horizon (which is the fog colour) instead of ending in a seam.
        const minX = Number(world.minX) || 0, maxX = Number(world.maxX) || 0;
        const minY = Number(world.minY) || 0, maxY = Number(world.maxY) || 0;
        const reach = (Number(atmosphere.fogEnd) || 900) * 1.3;
        const w = (maxX - minX) / WORLD_SCALE + reach * 2, d = (maxY - minY) / WORLD_SCALE + reach * 2;
        const groundGeom = new THREE.PlaneGeometry(w, d);
        groundGeom.rotateX(-Math.PI / 2);
        const ground = new THREE.Mesh(groundGeom, new THREE.MeshLambertMaterial({ color: hex(atmosphere.groundHex, '#2a3a24') }));
        ground.position.set((minX + maxX) / 2 / WORLD_SCALE, 0, (minY + maxY) / 2 / WORLD_SCALE);
        group.add(ground);
        this.groundMesh = ground;

        const hw = this.track.halfWidth;
        this.roadMesh = new THREE.Mesh(ribbon(this.track, -hw, hw, 0.02),
            new THREE.MeshLambertMaterial({ color: hex(atmosphere.roadHex, '#393b42'), side: THREE.DoubleSide }));
        group.add(this.roadMesh);

        // Edge lines on the tarmac, then the barriers where physics puts the wall.
        const lineMat = new THREE.MeshLambertMaterial({ color: 0xe8e8e8, side: THREE.DoubleSide });
        group.add(new THREE.Mesh(ribbon(this.track, -hw, -hw + 2.2, 0.03), lineMat));
        group.add(new THREE.Mesh(ribbon(this.track, hw - 2.2, hw, 0.03), lineMat));
        // physics.js stops a car's centre at hw + RUN_OFF - CAR_RADIUS/2; its flank is
        // half a car width further out, so that is where the barrier face belongs.
        const wallLat = hw + RUN_OFF;
        const barrierMat = new THREE.MeshLambertMaterial({ color: hex(atmosphere.accentHex, '#c6a35a'), side: THREE.DoubleSide });
        group.add(new THREE.Mesh(wall(this.track, -wallLat, 0.55), barrierMat));
        group.add(new THREE.Mesh(wall(this.track, wallLat, 0.55), barrierMat));

        group.add(startLine(this.track));

        this.racingLine = racingLineMesh(this.track);
        this.racingLine.visible = false;
        group.add(this.racingLine);

        try {
            this.scenery = new Scenery(this.track, { ...world, kerbs: computeKerbs(this.track) });
            group.add(this.scenery.group);
        } catch (e) {
            this.scenery = null;
            console.warn('pocabinet/scene: scenery skipped', e);
        }
        try {
            this.sky = new Sky(this.track.id);
            group.add(this.sky.mesh);
            this.sun.position.copy(this.sky.lightDirection()).multiplyScalar(100);
        } catch (e) {
            this.sky = null;
            console.warn('pocabinet/scene: sky skipped', e);
        }

        this.scene.add(group);
        this.trackGroup = group;
    }

    disposeTrackMeshes() {
        if (!this.trackGroup) return;
        this.scene.remove(this.trackGroup);
        this.scenery?.dispose();
        this.trackGroup.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
        this.trackGroup = null;
        this.racingLine = null;
        this.roadMesh = null;
        this.scenery = null;
        this.sky = null;
    }

    /** Match the canvas size to its CSS box; called on resize + after mount. */
    resize() {
        if (this.disposed || !this.canvas) return;
        const w = this.canvas.clientWidth || 800;
        const h = this.canvas.clientHeight || 450;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.post?.setSize();
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        window.removeEventListener('resize', this._onResize);
        this.stopLoop();
        this._frameCbs.clear();
        this.disposeTrackMeshes();
        this.post?.dispose();
        this.post = null;
        this.renderer.dispose();
    }
}

// ──────────────────────────────────────────────────────────────────────────
//  Geometry builders. Lateral offsets are sim units (+ = right of travel).
// ──────────────────────────────────────────────────────────────────────────

function ribbon(track, fromLat, toLat, height) {
    const positions = [];
    const n = track.count;
    for (let i = 0; i < n; i++) {
        const nx = -track.ty[i], ny = track.tx[i];
        const x = track.x[i], y = track.y[i];
        positions.push(
            (x + nx * fromLat) / WORLD_SCALE, height, (y + ny * fromLat) / WORLD_SCALE,
            (x + nx * toLat) / WORLD_SCALE, height, (y + ny * toLat) / WORLD_SCALE,
        );
    }
    return strip(positions, n);
}

function wall(track, lateral, height) {
    const positions = [];
    const n = track.count;
    for (let i = 0; i < n; i++) {
        const px = (track.x[i] + -track.ty[i] * lateral) / WORLD_SCALE;
        const pz = (track.y[i] + track.tx[i] * lateral) / WORLD_SCALE;
        positions.push(px, 0, pz, px, height, pz);
    }
    return strip(positions, n);
}

function strip(positions, n) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const indices = [];
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a0 = i * 2, a1 = i * 2 + 1, b0 = j * 2, b1 = j * 2 + 1;
        indices.push(a0, a1, b0, a1, b1, b0);
    }
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return geom;
}

/** Chequered strip across the road at distance 0 (the lap line). */
function startLine(track) {
    const group = new THREE.Group();
    const p = track.pointAt(0);
    const cols = 12, rows = 2, hw = track.halfWidth;
    const cell = (hw * 2) / cols;
    const geom = new THREE.PlaneGeometry(cell / WORLD_SCALE, cell / WORLD_SCALE);
    geom.rotateX(-Math.PI / 2);
    const white = new THREE.MeshLambertMaterial({ color: 0xf5f5f5 });
    const black = new THREE.MeshLambertMaterial({ color: 0x111111 });
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const lat = -hw + cell * (c + 0.5);
            const fwd = (r - 0.5) * cell;
            const m = new THREE.Mesh(geom, (r + c) % 2 === 0 ? white : black);
            m.position.set(
                (p.x + -p.ty * lat + p.tx * fwd) / WORLD_SCALE,
                0.035,
                (p.y + p.tx * lat + p.ty * fwd) / WORLD_SCALE);
            m.rotation.y = -Math.atan2(p.ty, p.tx);
            group.add(m);
        }
    }
    return group;
}

/**
 * Racing-line assist: a thin line down the centre coloured by the speed the
 * curvature allows — green flat out, amber lift, red brake. Same curvature and
 * grip numbers the AI and the auto-brake use, so the colours never lie.
 */
function racingLineMesh(track) {
    const positions = [];
    const colors = [];
    const green = new THREE.Color('#2ecc71'), amber = new THREE.Color('#f1c40f'), red = new THREE.Color('#e74c3c');
    const c = new THREE.Color();
    for (let i = 0; i <= track.count; i++) {
        const k = i % track.count;
        positions.push(track.x[k] / WORLD_SCALE, 0.065, track.y[k] / WORLD_SCALE);
        let kappa = 0;
        for (let j = 0; j < 8; j++) kappa = Math.max(kappa, track.curvatureAt((k + j) % track.count));
        const vMax = Math.sqrt(GRIP_ACCEL * 0.9 / Math.max(kappa, 1e-5));
        const t = Math.min(1, Math.max(0, (vMax - 80) / 50)); // ≤80 u/s brake … ≥130 flat out
        if (t > 0.5) c.copy(amber).lerp(green, (t - 0.5) * 2);
        else c.copy(red).lerp(amber, t * 2);
        colors.push(c.r, c.g, c.b);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return new THREE.Line(geom, new THREE.LineBasicMaterial({ vertexColors: true }));
}

// ──────────────────────────────────────────────────────────────────────────
//  Public mount / unmount.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Mount the scene on a canvas.
 * @param {HTMLCanvasElement|string} canvas the element, or its DOM id — Blazor's
 *        IJSRuntime does not marshal ElementReference as a live element.
 * @param {{ atmosphere: object, centerXY: number[], trackWidth: number,
 *           minX: number, minY: number, maxX: number, maxY: number }} world
 */
export async function mount(canvas, world) {
    if (typeof canvas === 'string') canvas = document.getElementById(canvas);
    if (!canvas) throw new Error('pocabinet/scene: canvas element is required');
    if (!world || !world.atmosphere) throw new Error('pocabinet/scene: world is required');

    // preserveDrawingBuffer so the clip recorder and the result card can read frames back.
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const scene = new THREE.Scene();
    // Near plane 0.25: the cockpit's closest part sits ~0.9 ahead, and the extra depth
    // precision keeps the stacked road overlays (lines, kerbs, skid marks) from shimmering.
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.25, 5000);
    camera.position.set(0, EYE_HEIGHT, 0);
    scene.add(camera);

    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, 0.7);
    sun.position.set(50, 80, 30);
    scene.add(sun);

    const handle = new SceneHandle(renderer, scene, camera, ambient, sun, canvas);
    try {
        handle.post = new PostFx(renderer);
    } catch (e) {
        handle.post = null;   // no post pass: the scene renders straight to the canvas
        console.warn('pocabinet/scene: post-processing unavailable', e);
    }
    handle.setTrack(world);
    const start = handle.track.pointAt(-40);
    handle.setView({ x: start.x, y: start.y, heading: Math.atan2(start.ty, start.tx), mode: 'cockpit' });
    handle.resize();
    handle.startLoop();
    return handle;
}

export function unmount(handle) {
    if (!handle) return;
    handle.dispose();
}

// Diagnostic hook for E2E smoke tests.
export function sceneApi() {
    return {
        isMounted: (handle) => handle && !handle.disposed,
        version: 'pocabinet-scene@2.0.0',
    };
}
