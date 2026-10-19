// pocabinet/kerbs.js
//
// Apex kerbs: which centerline points carry a red/white kerb, on which side, and whether it
// is a raised "sausage" kerb. The map itself is the world's (PoCabinetTrackFeatures computes
// it once, server-side, so both physics copies and the scene read the same one): this module
// is the scene's view of it, for drawing.
//
// Kerbs are physics (physics.js surfaceAt: a flat kerb has a little less grip, a raised one
// scrubs speed and throws the car out); the buzz race.js plays reads surfaceAt too.
//
// Side convention matches track.project: +1 = right of travel. A right-hander
// (heading increasing — steer +1) has its apex on the right, so the kerb goes there.

/** Int8Array, one entry per centerline point: 0 = no kerb, ±1 = kerb side. */
export function computeKerbs(track) {
    return Int8Array.from(track.kerbs, k => Math.sign(k));
}

/** True when the kerb at centerline point `i` is a raised one. */
export function raised(track, i) {
    const k = track.kerbs[i];
    return k === 2 || k === -2;
}
