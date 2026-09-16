// simWorker.js — dedicated module worker hosting the simulation (plan decision 1).
//
// Import maps do not apply inside workers, so cannon-es comes from the absolute CDN URL in
// config.js; a failed import leaves physics off (nullPhysics) rather than killing the sim.
// Messages that arrive while the module is still evaluating are queued and replayed.
//
// Both dependencies run against a deadline (see deadline.js): neither a silent CDN nor an
// IndexedDB open blocked behind another tab may hold the island hostage, because every
// message the page needs — terrain included — is posted after this await.
import { createSimRuntime } from './simRuntime.js';
import { memoryIdb, openWorldStore } from '../sim/persistence/idb.js';
import { CANNON_CDN_URL } from '../sim/core/config.js';
import { BOOT_DEADLINE_MS, withDeadline } from './deadline.js';

const queue = [];
self.onmessage = (e) => queue.push(e.data);

const fail = (where, message) => self.postMessage({ type: 'error', where, message });

// The CDN fetch and the IndexedDB open are independent — overlapping them makes the
// worker responsive a full network round-trip sooner.
const [CANNON, idb] = await Promise.all([
  withDeadline(
    import(/* @vite-ignore */ CANNON_CDN_URL).catch((err) => { fail('cannon', String(err?.message ?? err)); return null; }),
    BOOT_DEADLINE_MS,
    // A late arrival is ignored on purpose: physics is fixed for the life of a world, and
    // a world built without it cannot adopt a rigid-body solver halfway through.
    () => { fail('cannon', `cannon-es did not load within ${BOOT_DEADLINE_MS} ms — running without physics`); return null; },
  ),
  withDeadline(
    openWorldStore(),
    BOOT_DEADLINE_MS,
    () => { fail('storage', `the world store did not open within ${BOOT_DEADLINE_MS} ms — this island will not be saved`); return memoryIdb(); },
  ),
]);
const runtime = createSimRuntime((msg, transfer) => self.postMessage(msg, transfer ?? []), { CANNON, idb });

self.onmessage = (e) => runtime.handle(e.data);
for (const msg of queue) runtime.handle(msg);
queue.length = 0;
