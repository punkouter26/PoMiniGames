// pocabinet/cars.js
//
// Car models for PoCabinet. One shared set of geometries per page; per-car
// materials (paint colour, light intensities) so a livery never touches another car.
//
// The model: an extruded side profile for the body, a glass greenhouse with a
// painted roof and pillars, spoiler, mirrors and trim merged into as few draw calls
// as possible (paint / trim / glass / lights), four wheels (tyre + spoked rim) on
// pivots so the fronts steer, and a soft contact shadow. Paint is a clearcoat
// MeshPhysicalMaterial, so the sky environment map shows in it.
//
// Everything is derived from the pose race.js already has: steering angle from
// yaw rate, body roll from lateral acceleration, pitch and brake lights from
// longitudinal acceleration. Nothing here reads or changes physics.
//
// World: sim (x, y) → three (x / 10, 0, y / 10); the car is built along +X and
// rotated by −heading about Y (unchanged from the box cars it replaces).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const WHEEL_R = 0.36;
const WHEELS = [[1.2, 0.8, true], [1.2, -0.8, true], [-1.22, 0.8, false], [-1.22, -0.8, false]];

let GEO = null;

function extrude(shape, width, bevel) {
    const g = new THREE.ExtrudeGeometry(shape, {
        depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel,
        bevelSegments: 3, curveSegments: 12,
    });
    g.translate(0, 0, -(width - bevel * 2) / 2);
    return g;
}

/** A box placed by a matrix, de-indexed so it merges with extrusions. */
function box(w, h, d, x, y, z, rz = 0, ry = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, rz)),
        new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(m);
    return g.toNonIndexed();
}

function strut(x0, y0, x1, y1, z, t) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    return box(len, t, t, (x0 + x1) / 2, (y0 + y1) / 2, z, Math.atan2(y1 - y0, x1 - x0));
}

function geometry() {
    if (GEO) return GEO;
    // Side profile: x forward, y up, extruded across the width (z).
    const body = new THREE.Shape();
    body.moveTo(-1.84, 0.22);
    body.lineTo(1.8, 0.22);
    body.quadraticCurveTo(1.95, 0.24, 1.94, 0.4);
    body.quadraticCurveTo(1.9, 0.52, 1.7, 0.56);
    body.quadraticCurveTo(1.3, 0.63, 0.98, 0.66);
    body.lineTo(-1.1, 0.69);
    body.quadraticCurveTo(-1.62, 0.71, -1.84, 0.66);
    body.quadraticCurveTo(-1.96, 0.46, -1.84, 0.22);
    const bodyGeo = extrude(body, 1.66, 0.07);

    // Wheel arches: dark cut-outs are faked by the trim arches below.
    const cabin = new THREE.Shape();
    cabin.moveTo(-1.08, 0.66);
    cabin.lineTo(0.96, 0.66);
    cabin.quadraticCurveTo(0.6, 0.92, 0.34, 1.05);
    cabin.lineTo(-0.5, 1.06);
    cabin.quadraticCurveTo(-0.8, 0.95, -1.08, 0.66);
    const glass = extrude(cabin, 1.3, 0.04);

    const paint = mergeGeometries([
        bodyGeo,
        box(0.9, 0.045, 1.26, -0.08, 1.075, 0),                      // roof
        strut(0.96, 0.67, 0.34, 1.06, 0.62, 0.06), strut(0.96, 0.67, 0.34, 1.06, -0.62, 0.06),     // A-pillars
        strut(-1.08, 0.67, -0.5, 1.07, 0.62, 0.07), strut(-1.08, 0.67, -0.5, 1.07, -0.62, 0.07),   // C-pillars
        box(0.06, 0.4, 0.06, -0.08, 0.86, 0.63), box(0.06, 0.4, 0.06, -0.08, 0.86, -0.63),          // B-pillars
        box(0.34, 0.035, 1.72, -1.72, 0.9, 0),                       // wing
        box(0.12, 0.2, 0.08, 0.72, 0.74, 0.86), box(0.12, 0.2, 0.08, 0.72, 0.74, -0.86), // mirrors
    ]);
    const trim = mergeGeometries([
        box(0.1, 0.16, 1.5, 1.96, 0.3, 0),                           // front bumper lip
        box(0.08, 0.14, 1.1, 1.93, 0.43, 0),                         // grille
        box(0.1, 0.16, 1.5, -1.95, 0.3, 0),                          // rear diffuser
        box(0.06, 0.16, 0.05, -1.66, 0.8, 0.5), box(0.06, 0.16, 0.05, -1.66, 0.8, -0.5), // wing stands
        box(3.3, 0.06, 1.5, 0, 0.2, 0),                              // floor
        box(2.0, 0.08, 0.04, 0, 0.26, 0.86), box(2.0, 0.08, 0.04, 0, 0.26, -0.86),     // sills
    ]);
    const head = mergeGeometries([box(0.05, 0.09, 0.34, 1.9, 0.5, 0.52), box(0.05, 0.09, 0.34, 1.9, 0.5, -0.52)]);
    const tail = mergeGeometries([box(0.05, 0.1, 0.36, -1.9, 0.56, 0.56), box(0.05, 0.1, 0.36, -1.9, 0.56, -0.56)]);

    const tyre = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.28, 24, 1);
    tyre.rotateX(Math.PI / 2);
    const rimParts = [];
    const disc = new THREE.CylinderGeometry(0.25, 0.25, 0.29, 20, 1);
    disc.rotateX(Math.PI / 2);
    rimParts.push(disc.toNonIndexed());
    for (let i = 0; i < 5; i++) {
        const a = i / 5 * Math.PI * 2;
        for (const z of [0.147, -0.147]) {
            const s = new THREE.BoxGeometry(0.22, 0.045, 0.012);
            s.translate(0.11, 0, 0);
            s.rotateZ(a);
            s.translate(0, 0, z);
            rimParts.push(s.toNonIndexed());
        }
    }
    const rim = mergeGeometries(rimParts);

    const shadow = new THREE.PlaneGeometry(4.6, 2.5);
    shadow.rotateX(-Math.PI / 2);

    GEO = { paint, glass, trim, head, tail, tyre, rim, shadow };
    return GEO;
}

let shadowTex = null;
function contactShadowTexture() {
    if (shadowTex) return shadowTex;
    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 32, 4, 64, 32, 62);
    grd.addColorStop(0, 'rgba(0,0,0,0.85)');
    grd.addColorStop(0.55, 'rgba(0,0,0,0.45)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 64);
    shadowTex = new THREE.CanvasTexture(c);
    return shadowTex;
}

// Shared (colour-independent) materials.
let SHARED = null;
function shared() {
    if (SHARED) return SHARED;
    SHARED = {
        glass: new THREE.MeshPhysicalMaterial({ color: '#0c1116', roughness: 0.04, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.02 }),
        trim: new THREE.MeshStandardMaterial({ color: '#15171a', roughness: 0.55, metalness: 0.2 }),
        tyre: new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.92, metalness: 0 }),
        rim: new THREE.MeshStandardMaterial({ color: '#c9ccd2', roughness: 0.22, metalness: 1 }),
        shadow: new THREE.MeshBasicMaterial({ map: contactShadowTexture(), transparent: true, depthWrite: false, opacity: 0.75 }),
    };
    return SHARED;
}

const HEAD_DAY = new THREE.Color('#fff4dc').multiplyScalar(1.2);
const HEAD_NIGHT = new THREE.Color('#fff1d0').multiplyScalar(9);
const TAIL = new THREE.Color('#ff1a12');

class CarHandle {
    constructor(group, chassis, paint, headMat, tailMat, wheels) {
        this.group = group;
        this.chassis = chassis;
        this.paint = paint;
        this.headMat = headMat;
        this.tailMat = tailMat;
        this.wheels = wheels;
        this.disposed = false;
        this.night = 0;
        this.spin = 0;
        this.steer = 0;
        this.roll = 0;
        this.pitch = 0;
        this.braking = 0;
        this.last = null;
        this.headlight = null;
        this.applyLights();
    }

    /**
     * Place the car. `snap` = { x, y, heading, speedKmh } (sim units).
     * Called every rendered frame by race.js; the secondary motion is time-based.
     */
    update(snap) {
        if (this.disposed || !snap) return;
        const now = performance.now();
        const x = snap.x / 10, z = snap.y / 10;
        const speed = (Number(snap.speedKmh) || 0) / 2 / 10;     // world units/s
        this.group.position.set(x, 0, z);
        this.group.rotation.y = -snap.heading;

        if (this.last) {
            const dt = Math.min(0.1, Math.max(1e-3, (now - this.last.t) / 1000));
            let dh = snap.heading - this.last.h;
            dh = Math.atan2(Math.sin(dh), Math.cos(dh));
            const yawRate = dh / dt;
            const accel = (speed - this.last.v) / dt;
            const k = 1 - Math.exp(-dt * 8);
            const steerTarget = Math.max(-0.45, Math.min(0.45, yawRate * 0.35 * (speed > 0.5 ? 1 : 0)));
            this.steer += (steerTarget - this.steer) * k;
            this.roll += (Math.max(-0.07, Math.min(0.07, -yawRate * speed * 0.004)) - this.roll) * k;
            this.pitch += (Math.max(-0.05, Math.min(0.05, accel * 0.0028)) - this.pitch) * k;
            const brake = accel < -3 ? 1 : 0;
            if (brake !== this.braking) { this.braking = brake; this.applyLights(); }
            this.spin -= speed * dt / WHEEL_R;
        }
        this.last = { t: now, h: snap.heading, v: speed };
        this.chassis.rotation.x = this.roll;
        this.chassis.rotation.z = this.pitch;
        for (const w of this.wheels) {
            if (w.front) w.pivot.rotation.y = this.steer;
            w.tyre.rotation.z = this.spin;
            w.rim.rotation.z = this.spin;
        }
    }

    /** 0 (day) … 1 (night): headlights and tail lights brighten to bloom. */
    setNight(n) {
        this.night = Math.min(1, Math.max(0, Number(n) || 0));
        this.applyLights();
    }

    /** A real SpotLight for the car the camera follows (others get emissive lamps only). */
    setHeadlight(on) {
        if (on && !this.headlight) {
            const s = new THREE.SpotLight(0xfff0d0, 0, 70, 0.5, 0.55, 1.2);
            s.position.set(1.95, 0.6, 0);
            s.target.position.set(22, -0.8, 0);
            this.group.add(s, s.target);
            this.headlight = s;
        } else if (!on && this.headlight) {
            this.group.remove(this.headlight, this.headlight.target);
            this.headlight.dispose();
            this.headlight = null;
        }
        this.applyLights();
    }

    applyLights() {
        this.headMat.color.copy(HEAD_DAY).lerp(HEAD_NIGHT, this.night);
        const tail = (1.2 + this.night * 3) * (this.braking ? 2.6 : 1);
        this.tailMat.color.copy(TAIL).multiplyScalar(tail);
        if (this.headlight) this.headlight.intensity = 220 * this.night;
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        if (this.group.parent) this.group.parent.remove(this.group);
        this.setHeadlight(false);
        this.paint.dispose();
        this.headMat.dispose();
        this.tailMat.dispose();
    }
}

// ──────────────────────────────────────────────────────────────────────────
//  Per-official colour palette. Stays in JS so the wire DTO can ship a name
//  and the client resolves the hex locally.
// ──────────────────────────────────────────────────────────────────────────

export const OFFICIAL_COLORS = Object.freeze({
    'sean-s':   '#3470d8', // Press Secretary — defensive blue
    'steve-b':  '#5e4b8b', // Chief Strategist — purple, plotting
    'bill-b':   '#a02c2c', // AG — aggressive red
    'mike-p':   '#1c8054', // VP — steady green
});

function resolveColor(officialId, fallback) {
    if (officialId && OFFICIAL_COLORS[officialId]) return OFFICIAL_COLORS[officialId];
    return fallback || '#888888';
}

/**
 * Build a car and add it to `parent`. Returns a handle with `update(snap)`,
 * `setNight(n)`, `setHeadlight(on)` and `dispose()`.
 * @param {THREE.Object3D} parent
 * @param {{ id?: string, name: string, color?: string }} opts
 */
export function mountCar(parent, opts) {
    if (!parent) throw new Error('pocabinet/cars: parent object is required');
    if (!opts || !opts.name) throw new Error('pocabinet/cars: opts.name is required');
    const g = geometry();
    const m = shared();

    const paint = new THREE.MeshPhysicalMaterial({
        color: resolveColor(opts.id, opts.color), roughness: 0.32, metalness: 0.45,
        clearcoat: 1, clearcoatRoughness: 0.05,
    });
    const headMat = new THREE.MeshBasicMaterial({ color: HEAD_DAY.clone() });
    const tailMat = new THREE.MeshBasicMaterial({ color: TAIL.clone() });

    const group = new THREE.Group();
    group.name = `pocabinet-car-${opts.id || opts.name}`;
    const chassis = new THREE.Group();
    group.add(chassis);

    const add = (geom, mat, parentObj = chassis, cast = true) => {
        const mesh = new THREE.Mesh(geom, mat);
        mesh.castShadow = cast;
        mesh.receiveShadow = cast;
        parentObj.add(mesh);
        return mesh;
    };
    add(g.paint, paint);
    add(g.glass, m.glass);
    add(g.trim, m.trim);
    add(g.head, headMat, chassis, false);
    add(g.tail, tailMat, chassis, false);

    const wheels = [];
    for (const [x, z, front] of WHEELS) {
        const pivot = new THREE.Group();
        pivot.position.set(x, WHEEL_R, z);
        group.add(pivot);
        const tyre = add(g.tyre, m.tyre, pivot);
        const rim = add(g.rim, m.rim, pivot);
        wheels.push({ pivot, tyre, rim, front });
    }

    const shadow = new THREE.Mesh(g.shadow, m.shadow);
    shadow.position.y = 0.03;
    shadow.renderOrder = 1;
    group.add(shadow);

    parent.add(group);
    return new CarHandle(group, chassis, paint, headMat, tailMat, wheels);
}

export function unmountCar(handle) {
    if (!handle) return;
    handle.dispose();
}
