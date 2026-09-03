// simWorker.js — dedicated module worker hosting the simulation (plan decision 1).
//
// Import maps do not apply inside workers, so cannon-es comes from the absolute CDN URL in
// config.js; a failed import leaves physics off (nullPhysics) rather than killing the sim.
// Messages that arrive while the module is still evaluating are queued and replayed.
import { createSimRuntime } from './simRuntime.js';
import { openWorldStore } from '../sim/persistence/idb.js';
import { CANNON_CDN_URL } from '../sim/core/config.js';

const queue = [];
self.onmessage = (e) => queue.push(e.data);

// The CDN fetch and the IndexedDB open are independent — overlapping them makes the
// worker responsive a full network round-trip sooner.
const [CANNON, idb] = await Promise.all([
  import(/* @vite-ignore */ CANNON_CDN_URL).catch((err) => {
    self.postMessage({ type: 'error', where: 'cannon', message: String(err?.message ?? err) });
    return null;
  }),
  openWorldStore(),
]);
const runtime = createSimRuntime((msg, transfer) => self.postMessage(msg, transfer ?? []), { CANNON, idb });

self.onmessage = (e) => runtime.handle(e.data);
for (const msg of queue) runtime.handle(msg);
queue.length = 0;
