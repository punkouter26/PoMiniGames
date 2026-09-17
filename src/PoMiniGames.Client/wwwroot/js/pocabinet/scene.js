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
    }

    /**
     * Swap the active track's atmosphere + centerline. Called when the player
     * switches tracks in the selector or when /pocabinet/{mode} loads a non-default
     * track via the URL.
     */
    setTrack(atmosphere, centerline) {
        if (this.disposed) return;

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
        const a = centerline[i];
        const b = centerline[(i + 1) % centerline.length];
        // World-X = server X / 10 ; World-Z = server Y / 10 (scale down for screen)
        const ax = a.X / 10, az = a.Y / 10;
        const bx = b.X / 10, bz = b.Y / 10;
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
 * @param {HTMLCanvasElement} canvas
 * @param {{ skyHex: string, fogStart: number, fogEnd: number, fogHex: string,
 *           ambientIntensity: number, groundHex: string, accentHex: string }} atmosphere
 * @param {Array<{X: number, Y: number}>} centerline
 * @returns {Promise<SceneHandle>}
 */
export async function mount(canvas, atmosphere, centerline) {
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
    handle.resize();
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