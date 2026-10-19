// pocabinet/kerbs.js
//
// Apex kerbs: which centerline points carry a red/white kerb, on which side, and whether it
// is a raised "sausage" kerb. The map itself is the world's (PoCabinetTrackFeatures computes
// it once, server-side, so both physics copies and the scene read the same one): this module
// is the scene's and the feel layer's view of it.
//
// Kerbs are physics now (physics.js surfaceAt: a flat kerb has a little less grip, a raised
// one scrubs speed and throws the car out); what is here is only the drawing and the buzz.
//
// Side convention matches track.project: +1 = right of travel. A right-hander
// (heading increasing — steer +1) has its apex on the right, so the kerb goes there.

export { KERB_INNER, KERB_OUTER } from './physics.js';
import { KERB_INNER, KERB_OUTER } from './physics.js';

/** Int8Array, one entry per centerline point: 0 = no kerb, ±1 = kerb side. */
export function computeKerbs(track) {
    return Int8Array.from(track.kerbs, k => Math.sign(k));
}

/** True when the kerb at centerline point `i` is a raised one. */
export function raised(track, i) {
    const k = track.kerbs[i];
    return k === 2 || k === -2;
}

/** True when a car at centerline index `index` with signed `lateral` sits on a kerb. */
export function onKerb(kerbs, track, index, lateral) {
    if (!kerbs || index < 0 || index >= kerbs.length) return false;
    const s = kerbs[index];
    if (!s) return false;
    const l = lateral * s;
    const hw = track.hwAt(index);
    return l > hw - KERB_INNER && l < hw + KERB_OUTER;
}
