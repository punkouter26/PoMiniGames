// pocabinet/cockpit.js
//
// Cockpit interior — steering wheel (with shift lights and a gear readout fed by
// audio.js's virtual gearbox), hood, speedometer, rear-view mirror.
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
        // Layout note: the cockpit rides the camera (vertical FOV 60–90°), so at one unit
        // ahead the view spans roughly ±0.7 vertically. Everything below sits in the
        // bottom quarter or the top edge; the road ahead stays clear. (It was laid out
        // blind — the camera was never in the scene graph, so none of it rendered —
        // and on 2026-09-23 the mirror turned out to cover a third of the screen.)
        COCKPIT_GEOMETRY.wheel = new THREE.TorusGeometry(0.3, 0.045, 8, 28);
        COCKPIT_GEOMETRY.wheelHub = new THREE.CircleGeometry(0.08, 12);
        COCKPIT_GEOMETRY.wheelSpoke = new THREE.BoxGeometry(0.56, 0.05, 0.02);
        COCKPIT_GEOMETRY.dash = new THREE.BoxGeometry(2.6, 0.3, 0.3);
        COCKPIT_GEOMETRY.hood = new THREE.BoxGeometry(2.2, 0.04, 2.0);
        COCKPIT_GEOMETRY.mirror = new THREE.BoxGeometry(0.44, 0.1, 0.02);
        COCKPIT_GEOMETRY.mirrorFrame = new THREE.BoxGeometry(0.48, 0.13, 0.015);
        COCKPIT_GEOMETRY.gaugeFace = new THREE.CircleGeometry(0.1, 20);
        COCKPIT_GEOMETRY.gaugeBezel = new THREE.TorusGeometry(0.1, 0.012, 8, 20);
        // Needle pivots at one end: shift the box so its origin is the hub.
        const needle = new THREE.BoxGeometry(0.085, 0.008, 0.004);
        needle.translate(0.0425, 0, 0);
        COCKPIT_GEOMETRY.gaugeNeedle = needle;
        COCKPIT_GEOMETRY.led = new THREE.CircleGeometry(0.012, 10);
        COCKPIT_GEOMETRY.gearFace = new THREE.PlaneGeometry(0.075, 0.075);
    }
    return COCKPIT_GEOMETRY;
}

// Shift lights: green → red → blue as RPM climbs, all flashing at the limiter.
const LED_COLORS = ['#19d45a', '#19d45a', '#19d45a', '#ff2a2a', '#ff2a2a', '#ff2a2a', '#2a7dff', '#2a7dff', '#2a7dff'];
const LED_OFF = '#1a1c20';
const LED_FLASH = '#b8d4ff';
const LED_FROM = 0.62;
const LED_STEP = 0.04;

// ──────────────────────────────────────────────────────────────────────────
//  CockpitHandle — owns the cockpit group + per-frame HUD updates.
// ──────────────────────────────────────────────────────────────────────────

class CockpitHandle {
    constructor(group, gaugeNeedle, rearMirror, wheel, mirrorFrame, gauge) {
        this.group = group;
        this.gaugeNeedle = gaugeNeedle;
        this.rearMirror = rearMirror;
        this.wheel = wheel;
        this.mirrorFrame = mirrorFrame;
        this.gauge = gauge;
        this.aspect = 0;
        this.disposed = false;
    }

    /**
     * Portrait phones see a much narrower slice (half-width at one unit ≈ 0.7 × aspect):
     * shrink the mirror and pull the speedometer in so neither leaves or swamps the view.
     */
    layout(aspect) {
        if (!(aspect > 0) || Math.abs(aspect - this.aspect) < 0.01) return;
        this.aspect = aspect;
        const halfWidth = 0.7 * aspect;
        const s = Math.min(1, aspect / 1.4);
        this.rearMirror.scale.set(s, 1, 1);
        this.mirrorFrame.scale.set(s, 1, 1);
        this.gauge.position.x = Math.min(0.48, halfWidth * 0.62);
    }

    /**
     * Per-frame readouts: the gauge needle sweeps with speed, the wheel turns with
     * the steering input (visual lock ≈ 90° either way), and — when the audio
     * engine's virtual gearbox reports them — the wheel's shift lights fill with
     * RPM and the hub shows the gear.
     * @param {{ speedKmh: number, steer: number, rpm?: number, redline?: number, gear?: number }} hud
     */
    updateHud(hud) {
        if (this.disposed || !hud) return;
        this.layout(this.group.parent?.aspect);
        const t = Math.max(0, Math.min(1, (Number(hud.speedKmh) || 0) / 300));
        this.gaugeNeedle.rotation.z = Math.PI * 0.66 - t * Math.PI * 1.33;
        const steer = Math.max(-1, Math.min(1, Number(hud.steer) || 0));
        // The wheel torus lies in the view plane after mount; spin it about the view axis.
        this.wheel.rotation.z = -steer * Math.PI * 0.5;

        const redline = Number(hud.redline) || 0;
        if (this.leds && redline > 0) {
            const r = (Number(hud.rpm) || 0) / redline;
            const limiter = r > 0.965 && (performance.now() % 160) < 80;
            this.leds.forEach((led, i) => {
                const on = r >= LED_FROM + i * LED_STEP;
                const color = limiter ? LED_FLASH : on ? LED_COLORS[i] : LED_OFF;
                if (led.userData.color !== color) {
                    led.material.color.set(color);
                    led.userData.color = color;
                }
            });
        }
        const gear = Number(hud.gear) || 0;
        if (this.gearCanvas && gear !== this.gearShown) {
            this.gearShown = gear;
            const g = this.gearCanvas.getContext('2d');
            g.fillStyle = '#060708';
            g.fillRect(0, 0, 64, 64);
            g.fillStyle = '#ffd24a';
            g.font = '800 50px system-ui, sans-serif';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillText(gear > 0 ? String(gear) : 'N', 32, 35);
            this.gearTexture.needsUpdate = true;
        }
    }

    /** Hide the interior for chase / TV cameras. */
    setVisible(visible) {
        if (!this.disposed) this.group.visible = !!visible;
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
        // Detach group from any parent; shared geometry + materials are cached, do not
        // dispose. The shift lights and gear readout are per mount, so they go here.
        if (this.group.parent) this.group.parent.remove(this.group);
        for (const led of this.leds || []) led.material.dispose();
        this.gearTexture?.dispose();
        this.gearMaterial?.dispose();
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

    // ─── Dashboard across the bottom edge, bonnet sliver beyond it ───
    const dash = new THREE.Mesh(geom.dash, mats.hood);
    dash.position.set(0, -0.72, -1.05);
    group.add(dash);
    const hood = new THREE.Mesh(geom.hood, mats.hood);
    hood.position.set(0, -0.85, -2.1);
    group.add(hood);

    // ─── Steering wheel: tilted back on a mount; the wheel itself spins about its axis ───
    const wheelMount = new THREE.Group();
    wheelMount.position.set(0, -0.66, -0.9);
    wheelMount.rotation.x = -0.35;
    const wheel = new THREE.Mesh(geom.wheel, mats.rubber);
    wheel.add(new THREE.Mesh(geom.wheelHub, mats.chrome));
    wheel.add(new THREE.Mesh(geom.wheelSpoke, mats.rubber));
    wheelMount.add(wheel);
    group.add(wheelMount);

    // ─── Speedometer on the dash, right of the wheel ───
    const gauge = new THREE.Group();
    gauge.position.set(0.48, -0.5, -1.0);
    gauge.add(new THREE.Mesh(geom.gaugeFace, mats.bezel));
    gauge.add(new THREE.Mesh(geom.gaugeBezel, mats.chrome));
    const gaugeNeedle = new THREE.Mesh(geom.gaugeNeedle, mats.needle);
    gaugeNeedle.position.z = 0.004;
    gaugeNeedle.rotation.z = Math.PI * 0.66;
    gauge.add(gaugeNeedle);
    group.add(gauge);

    // ─── Rear-view mirror: a slim strip at the top edge ───
    const rearMirror = new THREE.Mesh(geom.mirror, mats.mirror);
    rearMirror.position.set(0, 0.56, -1.0);
    const mirrorFrame = new THREE.Mesh(geom.mirrorFrame, mats.rubber);
    mirrorFrame.position.set(0, 0.56, -1.005);
    group.add(mirrorFrame);
    group.add(rearMirror);

    // ─── Shift lights across the top of the wheel, gear readout on the hub ───
    // Children of the wheel, so they turn with it. Per mount (they change colour).
    const leds = [];
    for (let i = 0; i < LED_COLORS.length; i++) {
        const led = new THREE.Mesh(geom.led, new THREE.MeshBasicMaterial({ color: LED_OFF }));
        led.position.set((i - (LED_COLORS.length - 1) / 2) * 0.034, 0.2, 0.012);
        led.userData.color = LED_OFF;
        wheel.add(led);
        leds.push(led);
    }
    const gearCanvas = document.createElement('canvas');
    gearCanvas.width = gearCanvas.height = 64;
    const gearTexture = new THREE.CanvasTexture(gearCanvas);
    gearTexture.colorSpace = THREE.SRGBColorSpace;
    const gearMaterial = new THREE.MeshBasicMaterial({ map: gearTexture });
    const gearFace = new THREE.Mesh(geom.gearFace, gearMaterial);
    gearFace.position.z = 0.008;
    wheel.add(gearFace);

    // Camera-relative attachment: cockpit is a child of the camera so it rides with
    // the player's eye automatically. This matches racing-game convention (the dashboard
    // never lags the camera).
    camera.add(group);

    const handle = new CockpitHandle(group, gaugeNeedle, rearMirror, wheel, mirrorFrame, gauge);
    handle.leds = leds;
    handle.gearCanvas = gearCanvas;
    handle.gearTexture = gearTexture;
    handle.gearMaterial = gearMaterial;
    handle.gearShown = -1;
    handle.updateHud({ speedKmh: 0, steer: 0, gear: 1 });
    return handle;
}

export function unmountCockpit(handle) {
    if (!handle) return;
    handle.dispose();
}