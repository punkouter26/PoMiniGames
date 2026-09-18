// pocabinet/cockpit.js
//
// Cockpit interior — steering wheel, hood, RPM gauge, speedometer, rear-view mirror.
// Mounts into the three.js scene from scene.js; the camera is the player's eye, so
// these primitives hang around the camera and ride along with car motion.
//
// Trim-safety (ADR-9): geometry is allocated once in COCKPIT_GEOMETRY and reused
// per race; materials are shared; no reflection-based dispatch. Lambert chunk
// order is preserved (no custom shader injection).

import * as THREE from 'three';

// ──────────────────────────────────────────────────────────────────────────
//  Cached geometry + materials. Pre-allocated once per process.
// ──────────────────────────────────────────────────────────────────────────

const COCKPIT_GEOMETRY = {
    wheel: null,       // torus, oriented horizontally in front of the camera
    wheelHub: null,    // small disc inside the wheel
    hood: null,        // angled hood / dashboard plate
    mirror: null,      // flat mirror surface (a thin disc)
    gaugeBezel: null,  // ring around the RPM/speed gauge
    gaugeNeedle: null, // rectangular needle
};

const COCKPIT_MATERIALS = {
    chrome: null,
    rubber: null,
    hood: null,
    mirror: null,
    bezel: null,
    needle: null,
};

function getOrCreateMaterials() {
    if (!COCKPIT_MATERIALS.chrome) {
        COCKPIT_MATERIALS.chrome = new THREE.MeshLambertMaterial({ color: 0xc0c0c0 });
        COCKPIT_MATERIALS.rubber = new THREE.MeshLambertMaterial({ color: 0x1c1c1c });
        COCKPIT_MATERIALS.hood = new THREE.MeshLambertMaterial({ color: 0x202028, side: THREE.DoubleSide });
        COCKPIT_MATERIALS.mirror = new THREE.MeshLambertMaterial({ color: 0xa0d4ff });
        COCKPIT_MATERIALS.bezel = new THREE.MeshLambertMaterial({ color: 0x303038 });
        COCKPIT_MATERIALS.needle = new THREE.MeshLambertMaterial({ color: 0xff3838 });
    }
    return COCKPIT_MATERIALS;
}

function getOrCreateGeometry() {
    if (!COCKPIT_GEOMETRY.wheel) {
        // Steering wheel: torus with a 0.4 radius, 0.06 tube.
        const w = new THREE.TorusGeometry(0.4, 0.06, 8, 24);
        w.rotateX(Math.PI / 2);
        COCKPIT_GEOMETRY.wheel = w;

        COCKPIT_GEOMETRY.wheelHub = new THREE.CircleGeometry(0.12, 12);

        // Hood: trapezoid plate, facing up and forward.
        COCKPIT_GEOMETRY.hood = new THREE.BoxGeometry(3.0, 0.05, 1.6);

        // Mirror: thin disc mounted above the windshield.
        const m = new THREE.CircleGeometry(0.45, 16);
        COCKPIT_GEOMETRY.mirror = m;

        // Gauge bezel: ring around a gauge face.
        COCKPIT_GEOMETRY.gaugeBezel = new THREE.TorusGeometry(0.18, 0.02, 8, 18);

        // Gauge needle: thin elongated box.
        COCKPIT_GEOMETRY.gaugeNeedle = new THREE.BoxGeometry(0.16, 0.012, 0.008);
    }
    return COCKPIT_GEOMETRY;
}

// ──────────────────────────────────────────────────────────────────────────
//  CockpitHandle — owns the cockpit group + per-frame HUD updates.
// ──────────────────────────────────────────────────────────────────────────

class CockpitHandle {
    constructor(group, gaugeNeedle, rearMirror, wheel) {
        this.group = group;
        this.gaugeNeedle = gaugeNeedle;
        this.rearMirror = rearMirror;
        this.wheel = wheel;
        this.disposed = false;
    }

    /**
     * Update the cockpit readouts from the latest sim snapshot.
     * @param {{ speed: number, rpm: number, gear: number, lap: number, position: number }} hud
     */
    updateHud(hud) {
        if (this.disposed || !hud) return;
        // RPM needle rotation: 0..1 → -120°..+120°
        const t = Math.max(0, Math.min(1, (hud.rpm || 0) / 8000));
        this.gaugeNeedle.rotation.z = -Math.PI * 0.66 + t * Math.PI * 1.33;
        // Steering wheel matches player heading. (Server broadcasts car heading;
        // the cockpit hook reads the camera's quaternion instead for camera-relative
        // rotation, but the v1 simplification is to rotate the wheel only when the
        // player steers, which the racing service drives.)
        // The wheel multiplier is in radians per second; we leave that to the racing
        // service which calls setSteering. Stubbed out for T2:
        // this.wheel.rotation.y = hud.steering || 0;
        // (T2: leave at zero; T7 wires the steering input handler.)
        void hud;
    }

    /**
     * Mount the cockpit onto a parent three.js Object3D (typically the camera or
     * the scene root). Returns the cockpit group for cleanup.
     */
    attachTo(parent) {
        parent.add(this.group);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        // Detach group from any parent; geometry + materials are cached, do not dispose.
        if (this.group.parent) this.group.parent.remove(this.group);
    }
}

// ──────────────────────────────────────────────────────────────────────────
//  Public mount / unmount.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build the cockpit interior. Returns a handle with `updateHud(hud)` and `dispose()`.
 *
 * @param {THREE.Camera|{camera: THREE.Camera}} sceneOrCamera the player's camera,
 *        or the scene handle from scene.js (whose `.camera` we mount into). The
 *        page passes the scene handle; the cockpit must ride the camera so it
 *        tracks the player's eye.
 * @returns {CockpitHandle}
 */
export function mountCockpit(sceneOrCamera) {
    const camera = sceneOrCamera && sceneOrCamera.isCamera
        ? sceneOrCamera
        : sceneOrCamera?.camera;
    if (!camera || typeof camera.add !== 'function') {
        throw new Error('pocabinet/cockpit: camera is required');
    }

    const geom = getOrCreateGeometry();
    const mats = getOrCreateMaterials();

    const group = new THREE.Group();
    group.name = 'pocabinet-cockpit';

    // ─── Steering wheel: in front of the camera, slightly below eye level ──
    const wheel = new THREE.Mesh(geom.wheel, mats.rubber);
    wheel.position.set(0, -0.55, -1.1);
    const wheelHub = new THREE.Mesh(geom.wheelHub, mats.chrome);
    wheel.add(wheelHub);
    group.add(wheel);

    // ─── Hood: angled plate visible at the bottom of the view ───
    const hood = new THREE.Mesh(geom.hood, mats.hood);
    hood.position.set(0, -0.95, -0.2);
    hood.rotation.x = -Math.PI / 6;
    group.add(hood);

    // ─── RPM gauge needle (the only piece that animates each frame) ───
    const gaugeNeedle = new THREE.Mesh(geom.gaugeNeedle, mats.needle);
    gaugeNeedle.position.set(0, 0, -0.95);
    gaugeNeedle.rotation.z = -Math.PI * 0.66;
    group.add(gaugeNeedle);

    // ─── Gauge bezel (decorative; doesn't move) ───
    const bezel = new THREE.Mesh(geom.gaugeBezel, mats.bezel);
    bezel.position.set(0, 0, -0.96);
    group.add(bezel);

    // ─── Rear-view mirror: thin disc above and ahead of the camera ───
    const rearMirror = new THREE.Mesh(geom.mirror, mats.mirror);
    rearMirror.position.set(0, 0.55, -0.85);
    group.add(rearMirror);

    // Camera-relative attachment: cockpit is a child of the camera so it rides with
    // the player's eye automatically. This matches racing-game convention (the dashboard
    // never lags the camera).
    camera.add(group);

    return new CockpitHandle(group, gaugeNeedle, rearMirror, wheel);
}

export function unmountCockpit(handle) {
    if (!handle) return;
    handle.dispose();
}