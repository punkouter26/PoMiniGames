// simHost.js — the main thread's handle on the simulation: a module worker when one can
// start, otherwise the same runtime inline (loudly, so `__poeco().mode` shows it).
import { createSimRuntime } from './simRuntime.js';
import { openWorldStore } from '../sim/persistence/idb.js';

export async function createSimHost({ onMessage, WorkerCtor = globalThis.Worker, workerUrl = null, importCannon = null, idb = null, log = null } = {}) {
  const say = (m) => { if (log) log(m); };

  async function inline() {
    let CANNON = null;
    try { CANNON = importCannon ? await importCannon() : null; } catch (err) { say(`cannon-es unavailable inline: ${err?.message ?? err}`); }
    const store = idb ?? await openWorldStore();
    const runtime = createSimRuntime((msg) => queueMicrotask(() => onMessage(msg)), { CANNON, idb: store });
    say('PoEcosystem sim running INLINE on the main thread (worker unavailable)');
    return { mode: 'inline', runtime, send: (msg) => runtime.handle(msg), dispose: () => runtime.dispose() };
  }

  if (typeof WorkerCtor !== 'function') return inline();
  let worker;
  try {
    worker = new WorkerCtor(workerUrl ?? new URL('./simWorker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    say(`sim worker failed to start: ${err?.message ?? err}`);
    return inline();
  }

  const sent = [];      // replayed if the worker dies before it is ready
  let ready = false;
  let fallback = null;
  const host = {
    mode: 'worker',
    worker,
    send(msg, transfer) {
      if (fallback) { fallback.send(msg); return; }
      if (!ready && msg.type !== 'recycle') sent.push(msg);
      worker.postMessage(msg, transfer ?? []);
    },
    dispose() { if (fallback) fallback.dispose(); else { try { worker.postMessage({ type: 'dispose' }); } catch { /* gone */ } worker.terminate(); } },
  };
  worker.onmessage = (e) => { if (e.data?.type === 'ready') ready = true; onMessage(e.data); };
  worker.onerror = async (err) => {
    say(`sim worker error: ${err?.message ?? err}`);
    if (ready || fallback) return;
    worker.terminate();
    fallback = await inline();
    host.mode = 'inline';
    for (const msg of sent) fallback.send(msg);
  };
  return host;
}
