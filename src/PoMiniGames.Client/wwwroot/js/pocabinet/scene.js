// pocabinet/scene.js
//
// Three.js scene base for PoCabinet. Owns:
//   • scene, camera, fog, ambient + directional lights
//   • ground plane tinted from atmosphere.GroundHex
//   • a track ribbon (extruded shape from the spline) tinted from atmosphere.AccentHex
//
// Trim-audit safety (ADR-9): geometry is allocated once via GEOMETRY_CACHE and reused
// per-track; materials are shared singletons; no reflection-based dispatch. Lambert
// material follows the PoEcosystem chunk-order rule — `normal_fragment_begin` runs
// BEFORE `color_fragment`, so any normal-dependent shader code must hook the earlier
// chunk. We do not inject any custom shader code yet (T1 ships plain Lambert).
//
// API surface:
//   const handle = await scene.mount(canvas, atmosphere, centerline);
//   scene.unmount(handle);
//   handle.setTrack(atmosphere, centerline);

import * as THREE from 'three';

// ──────────────────────────────────────────────────────────────────────────
//  Cached geometry. Pre-allocated once per process; never re-built per mount.
//  The trim analyzer requires no per-mount allocations of BufferGeometry.
// ──────────────────────────────────────────────────────────────────────────

const GEOMETRY_CACHE = {
    groundPlane: null,        // 100×100 plane, reused per mount (just translated/scaled)
    trackRibbon: null,        // empty; rebuilt when a new centerline arrives
};

// ──────────────────────────────────────────────────────────────────────────
//  Shared materials. Constructed lazily on first mount; reused across tracks.
// ──────────────────────────────────────────────────────────────────────────

const MATERIAL_CACHE = {
    ground: null,
    track: null,
};

function getOrCreateGroundMaterial() {
    if (!MATERIAL_CACHE.ground) {
        MATERIAL_CACHE.ground = new THREE.MeshLambertMaterial({ color: 0xc8c2b3, side: THREE.DoubleSide });
    }
    return MATERIAL_CACHE.ground;
}

function getOrCreateTrackMaterial() {
    if (!MATERIAL_CACHE.track) {
        MATERIAL_CACHE.track = new THREE.MeshLambertMaterial({ color: 0xd4af37, side: THREE.DoubleSide });
    }
    return MATERIAL_CACHE.track;
}

// ──────────────────────────────────────────────────────────────────────────
//  Per-mount state. A handle tracks everything that needs teardown so the
//  renderer can swap tracks mid-session without leaking GPU resources.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Centerline points arrive either as [x, y] arrays (C# double[][] via
 * IJSRuntime) or {X, Y} objects — accept both. The wire shape drifted at some
 * point and the ribbon silently produced NaN vertices for one of them.
 */
function pointOf(p) {
    if (Array.isArray(p)) return { x: Number(p[0]) || 0, y: Number(p[1]) || 0 };
    return { x: Number(p?.X) || 0, y: Number(p?.Y) || 0 };
}

class SceneHandle {
    constructor(renderer, scene, camera, ambient, sun, groundMesh, trackMesh, canvas) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;
        this.ambient = ambient;
        this.sun = sun;
        this.groundMesh = groundMesh;
        this.trackMesh = trackMesh;
        this.canvas = canvas;
        this.disposed = false;
        // Atmosphere the track was mounted with (unmodified) — environment.js
        // derives night/rain lighting from this baseline.
        this.baseAtmosphere = null;
        // Per-frame callbacks (environment rain field, future FX). Registration
        // is ref-counted so dispose() always unwinds cleanly.
        this._frameCbs = new Set();
        this._raf = null;
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
            for (const cb of this._frameCbs) {
                try { cb(now); } catch { /* one bad effect never kills the frame */ }
            }
            this.renderer.render(this.scene, this.camera);
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
     * Cockpit camera follow: place the eye at the player's car and face its
     * heading. Called per snapshot — the RAF loop renders whatever the last
     * view was, so latency stays invisible.
     * Server X → world X, server Y → world Z (÷10 scene scale, cars.js rule).
     */
    updatePlayerView(p) {
        if (this.disposed || !p) return;
        const x = (Number(p.x) || 0) / 10;
        const z = (Number(p.y) || 0) / 10;
        const heading = Number(p.heading) || 0;
        this.camera.position.set(x, 4, z);
        // Car forward = (cos h, 0, sin h); camera default forward = -Z, so
        // yaw = -h - π/2 aligns the view with the body (cars.js convention).
        this.camera.rotation.set(0, -heading - Math.PI / 2, 0);
    }

    /**
     * Apply player view preferences — pixel-ratio cap multiplier + FOV.
     * Called from the settings facade; both values are clamped defensively.
     */
    applyView(opts) {
        if (this.disposed) return;
        const o = opts && typeof opts === 'object' ? opts : {};
        const scale = Math.min(1.5, Math.max(0.5, Number(o.renderScale) || 1));
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * scale);
        const fov = Math.min(90, Math.max(60, Number(o.fov) || 70));
        if (Math.abs(this.camera.fov - fov) > 0.01) {
            this.camera.fov = fov;
            this.camera.updateProjectionMatrix();
        }
    }

    /**
     * Swap the active track's atmosphere + centerline. Called when the player
     * switches tracks in the selector or when /pocabinet/{mode} loads a non-default
     * track via the URL.
     */
    setTrack(atmosphere, centerline) {
        if (this.disposed) return;

        // Keep the pristine baseline for environment.js night/rain math.
        this.baseAtmosphere = { ...atmosphere };

        // Atmosphere: sky color, fog, ambient intensity.
        this.scene.background = new THREE.Color(atmosphere.skyHex);
        this.scene.fog = new THREE.Fog(
            new THREE.Color(atmosphere.fogHex).getHex(),
            atmosphere.fogStart,
            atmosphere.fogEnd,
        );
        this.ambient.intensity = atmosphere.ambientIntensity;
        this.sun.intensity = Math.max(0.3, atmosphere.ambientIntensity + 0.2);

        // Ground tint from atmosphere.
        getOrCreateGroundMaterial().color.set(atmosphere.groundHex);

        // Track ribbon rebuild. Track ribbon is the only geometry that legitimately
        // changes per track; we dispose the previous mesh's geometry before swapping.
        if (this.trackMesh && this.trackMesh.geometry) {
            this.trackMesh.geometry.dispose();
        }
        const ribbonGeom = buildTrackRibbonGeometry(centerline);
        const ribbonMat = getOrCreateTrackMaterial();
        ribbonMat.color.set(atmosphere.accentHex);
        this.trackMesh.geometry = ribbonGeom;
    }

    /** Match the canvas size to its CSS box; called on resize + after mount. */
    resize() {
        if (this.disposed || !this.canvas) return;
        const w = this.canvas.clientWidth || 800;
        const h = this.canvas.clientHeight || 450;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.stopLoop();
        this._frameCbs.clear();
        // Materials and ground geometry are cached and reused — do NOT dispose them.
        // Only dispose the per-track ribbon geometry.
        if (this.trackMesh && this.trackMesh.geometry) {
            this.trackMesh.geometry.dispose();
        }
        this.renderer.dispose();
    }
}

// ──────────────────────────────────────────────────────────────────────────
//  Geometry builders.
// ──────────────────────────────────────────────────────────────────────────

function getOrCreateGroundGeometry() {
    if (!GEOMETRY_CACHE.groundPlane) {
        // 100×100 ground plane; sits at y=0. The track ribbon floats slightly above it.
        const g = new THREE.PlaneGeometry(100, 100);
        g.rotateX(-Math.PI / 2);
        GEOMETRY_CACHE.groundPlane = g;
    }
    return GEOMETRY_CACHE.groundPlane;
}

/**
 * Build a thin extruded ribbon from the centerline points. Centerlines arrive as
 * flat 2D points (Vec2 X/Y from the server); we treat X as world-X and Y as
 * world-Z so the ribbon lies flat on the ground plane.
 *
 * Trim-safety note: BufferGeometry is allocated per track switch (necessary
 * because the ribbon shape genuinely differs), but disposed by the handle on
 * swap. No reflection / dynamic lookup involved.
 */
function buildTrackRibbonGeometry(centerline) {
    if (!centerline || centerline.length < 2) {
        return new THREE.BufferGeometry();
    }

    const halfWidth = 6.0; // ~half of TrackWidth=220 in server units, scaled to scene
    const positions = [];

    for (let i = 0; i < centerline.length; i++) {
        const a = pointOf(centerline[i]);
        const b = pointOf(centerline[(i + 1) % centerline.length]);
        // World-X = server X / 10 ; World-Z = server Y / 10 (scale down for screen)
        const ax = a.x / 10, az = a.y / 10;
        const bx = b.x / 10, bz = b.y / 10;
        const dx = bx - ax, dz = bz - az;
        const len = Math.hypot(dx, dz) || 1;
        const nx = -dz / len, nz = dx / len; // 90° CCW normal

        // Two vertices per centerline point: left edge and right edge.
        positions.push(
            ax + nx * halfWidth, 0.01, az + nz * halfWidth,
            ax - nx * halfWidth, 0.01, az - nz * halfWidth,
        );
    }

    const geom = new THREE.BufferGeometry();
    const posAttr = new THREE.Float32BufferAttribute(positions, 3);
    geom.setAttribute('position', posAttr);

    const indices = [];
    for (let i = 0; i < centerline.length; i++) {
        const j = (i + 1) % centerline.length;
        const a0 = i * 2, a1 = i * 2 + 1;
        const b0 = j * 2, b1 = j * 2 + 1;
        // Two triangles per quad.
        indices.push(a0, b0, a1, a1, b0, b1);
    }
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return geom;
}

// ──────────────────────────────────────────────────────────────────────────
//  Public mount / unmount.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Mount the scene on a canvas element.
 *
 * @param {HTMLCanvasElement|string} canvas the element, or its DOM id — Blazor's
 *        IJSRuntime does not marshal ElementReference as a live element, so the
 *        id-string path is the reliable one.
 * @param {{ skyHex: string, fogStart: number, fogEnd: number, fogHex: string,
 *           ambientIntensity: number, groundHex: string, accentHex: string }} atmosphere
 * @param {Array<{X: number, Y: number}>} centerline
 * @returns {Promise<SceneHandle>}
 */
export async function mount(canvas, atmosphere, centerline) {
    if (typeof canvas === 'string') canvas = document.getElementById(canvas);
    if (!canvas) throw new Error('pocabinet/scene: canvas element is required');
    if (!atmosphere) throw new Error('pocabinet/scene: atmosphere is required');

    // Renderer
    const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(atmosphere.skyHex);
    scene.fog = new THREE.Fog(
        new THREE.Color(atmosphere.fogHex).getHex(),
        atmosphere.fogStart,
        atmosphere.fogEnd,
    );

    // Camera — first-person cockpit. We sit slightly above the track; the cockpit
    // interior is mounted by cockpit.js (T2).
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 5000);
    camera.position.set(0, 4, 0);
    camera.lookAt(0, 0, -10);

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, atmosphere.ambientIntensity);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, Math.max(0.3, atmosphere.ambientIntensity + 0.2));
    sun.position.set(50, 80, 30);
    scene.add(sun);

    // Ground
    const groundMesh = new THREE.Mesh(getOrCreateGroundGeometry(), getOrCreateGroundMaterial());
    scene.add(groundMesh);

    // Track ribbon
    const ribbonGeom = buildTrackRibbonGeometry(centerline || []);
    const trackMesh = new THREE.Mesh(ribbonGeom, getOrCreateTrackMaterial());
    scene.add(trackMesh);

    const handle = new SceneHandle(renderer, scene, camera, ambient, sun, groundMesh, trackMesh, canvas);
    handle.baseAtmosphere = {
        skyHex: atmosphere.skyHex,
        fogHex: atmosphere.fogHex,
        fogStart: atmosphere.fogStart,
        fogEnd: atmosphere.fogEnd,
        ambientIntensity: atmosphere.ambientIntensity,
        groundHex: atmosphere.groundHex,
        accentHex: atmosphere.accentHex,
    };
    handle.resize();
    handle.startLoop();
    return handle;
}

/**
 * Tear down a mounted scene. Disposes per-track ribbon geometry but keeps the
 * shared material/ground caches warm for the next mount.
 */
export function unmount(handle) {
    if (!handle) return;
    handle.dispose();
}

// Diagnostic hook — exposed for the E2E-UI smoke in T7.
export function sceneApi() {
    return {
        isMounted: (handle) => handle && !handle.disposed,
        version: 'pocabinet-scene@1.0.0',
    };
}