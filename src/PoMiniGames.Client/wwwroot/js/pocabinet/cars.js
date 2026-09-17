// pocabinet/cars.js
//
// Flat-shaded AI car meshes for PoCabinet. Each official gets a distinct primary
// color; the body shape is a single shared geometry tinted per instance via a
// material clone (cheap; the trim analyzer is happy because we never call into
// three.js's reflection-based dispatch).
//
// Trim-safety (ADR-9): one BufferGeometry is shared across all cars; per-car
// state is held by per-mesh material instances. No reflection-based dispatch.

import * as THREE from 'three';

// ──────────────────────────────────────────────────────────────────────────
//  Cached geometry. Pre-allocated once per process; reused per car.
// ──────────────────────────────────────────────────────────────────────────

const CAR_GEOMETRY = {
    body: null,        // long flat box for the chassis
    roof: null,        // smaller box for the cabin
    wheels: null,      // 4 short cylinders
};

function getOrCreateGeometry() {
    if (!CAR_GEOMETRY.body) {
        // Chassis: ~3.5 long × 1.4 wide × 0.4 tall.
        CAR_GEOMETRY.body = new THREE.BoxGeometry(3.5, 0.4, 1.4);
        // Cabin / roof: ~1.8 long × 1.1 wide × 0.5 tall, sits on top.
        CAR_GEOMETRY.roof = new THREE.BoxGeometry(1.8, 0.5, 1.1);
        // Wheels: short cylinders rotated so they roll along the long axis.
        CAR_GEOMETRY.wheels = new THREE.CylinderGeometry(0.32, 0.32, 0.25, 10);
        // Default cylinder axis is Y; rotate so wheels spin around the X axis (forward).
        CAR_GEOMETRY.wheels.rotateZ(Math.PI / 2);
    }
    return CAR_GEOMETRY;
}

// ──────────────────────────────────────────────────────────────────────────
//  CarHandle — owns a car mesh group + per-frame transforms.
// ──────────────────────────────────────────────────────────────────────────

class CarHandle {
    constructor(group, body, roof, wheels) {
        this.group = group;
        this.body = body;
        this.roof = roof;
        this.wheels = wheels;
        this.disposed = false;
        this._lastX = null;
        this._lastZ = null;
        this._heading = null;
        this._wheelSpin = 0;
    }

    /**
     * Apply a server snapshot to this car.
     * @param {{ x: number, y: number, heading: number, speedKmh: number }} snap
     */
    update(snap) {
        if (this.disposed || !snap) return;
        // Server coordinates: world X = server X / 10, world Z = server Y / 10.
        const x = snap.x / 10;
        const z = snap.y / 10;
        this.group.position.set(x, 0.5, z);
        // Heading comes from the server (radians). three.js car is built along +X, so
        // rotate around Y by -heading to keep that convention.
        this.group.rotation.y = -snap.heading;

        // Wheel spin: a crude proxy of forward speed. The wheels rotate around their local
        // X axis (which is forward of the car). Speed 100 km/h ≈ ~0.4 rad/tick at 30 Hz.
        this._wheelSpin += (snap.speedKmh || 0) * 0.004;
        for (const w of this.wheels) {
            w.rotation.x = this._wheelSpin;
        }
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        if (this.group.parent) this.group.parent.remove(this.group);
        // Geometry is cached; materials are per-car and disposed here.
        if (this.body && this.body.material) this.body.material.dispose();
        if (this.roof && this.roof.material) this.roof.material.dispose();
        for (const w of this.wheels) if (w.material) w.material.dispose();
    }
}

// ──────────────────────────────────────────────────────────────────────────
//  Per-official color palette. Stays in JS so the wire DTO can ship a name
//  and the client resolves the hex locally — keeps the wire shape small and
//  gives us one place to recolor the roster.
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

// ──────────────────────────────────────────────────────────────────────────
//  Public factory.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build a car mesh for an AI official. Returns a handle with `update(snap)` and
 * `dispose()`. The handle is added to the parent scene by the caller.
 *
 * @param {THREE.Object3D} parent the scene (or a group) to add the car to
 * @param {{ id?: string, name: string, color?: string, isPlayer?: boolean }} opts
 * @returns {CarHandle}
 */
export function mountCar(parent, opts) {
    if (!parent) throw new Error('pocabinet/cars: parent object is required');
    if (!opts || !opts.name) throw new Error('pocabinet/cars: opts.name is required');

    const geom = getOrCreateGeometry();
    const primary = resolveColor(opts.id, opts.color);

    // Per-car materials — distinct MeshLambertMaterial instances so we can change
    // color without touching shared state. Cost is bounded (one mat per car) and
    // trim-safe (no reflection).
    const bodyMat = new THREE.MeshLambertMaterial({ color: primary });
    const roofMat = new THREE.MeshLambertMaterial({ color: Darken(primary, 0.6) });
    const wheelMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });

    const group = new THREE.Group();
    group.name = `pocabinet-car-${opts.id || opts.name}`;

    const body = new THREE.Mesh(geom.body, bodyMat);
    body.position.y = 0.0;
    group.add(body);

    const roof = new THREE.Mesh(geom.roof, roofMat);
    roof.position.y = 0.45;
    group.add(roof);

    // 4 wheels: front-left, front-right, rear-left, rear-right.
    const wheels = [];
    const wpos = [
        [1.2,  0,  0.75],
        [1.2,  0, -0.75],
        [-1.2, 0,  0.75],
        [-1.2, 0, -0.75],
    ];
    for (const [x, y, z] of wpos) {
        const w = new THREE.Mesh(geom.wheels, wheelMat);
        w.position.set(x, y, z);
        group.add(w);
        wheels.push(w);
    }

    parent.add(group);
    return new CarHandle(group, body, roof, wheels);
}

export function unmountCar(handle) {
    if (!handle) return;
    handle.dispose();
}

// Darken a hex color by mixing it toward black. trim-safe: pure arithmetic, no
// reflection; called once per car at mount.
function Darken(hex, factor) {
    const c = new THREE.Color(hex);
    c.r *= factor; c.g *= factor; c.b *= factor;
    return '#' + c.getHexString();
}