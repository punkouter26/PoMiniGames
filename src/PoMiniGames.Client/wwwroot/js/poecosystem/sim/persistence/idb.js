// idb.js — the world store. A tiny key/value surface (get/put/delete) over IndexedDB in
// the browser, or over a Map in tests and as a last-resort fallback. The sim worker owns
// the store, so autosave never crosses a thread boundary.

const DB_NAME = 'poecosystem';
const STORE = 'worlds';
const CURRENT = 'current';
const META = 'meta';

export function memoryIdb() {
  const map = new Map();
  return {
    kind: 'memory',
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
  };
}

/** Open (or create) the IndexedDB-backed store; falls back to memory when unavailable. */
export function openWorldStore(indexedDbImpl = globalThis.indexedDB) {
  if (!indexedDbImpl) return Promise.resolve(memoryIdb());
  return new Promise((resolve) => {
    const req = indexedDbImpl.open(DB_NAME, 1);
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
    req.onerror = () => resolve(memoryIdb());
    req.onsuccess = () => {
      const db = req.result;
      const run = (mode, fn) => new Promise((ok, fail) => {
        const tx = db.transaction(STORE, mode);
        const r = fn(tx.objectStore(STORE));
        r.onsuccess = () => ok(r.result === undefined ? null : r.result);
        r.onerror = () => fail(r.error);
      });
      resolve({
        kind: 'indexeddb',
        get: (key) => run('readonly', (s) => s.get(key)),
        put: (key, value) => run('readwrite', (s) => s.put(value, key)),
        delete: (key) => run('readwrite', (s) => s.delete(key)),
      });
    };
  });
}

export async function saveWorld(store, snapshot) {
  await store.put(CURRENT, snapshot);
  await store.put(META, { seed: snapshot.seed, tick: snapshot.tick, year: snapshot.year, savedAt: snapshot.savedAt, counts: snapshot.counts });
}

export const loadWorld = (store) => store.get(CURRENT);
export const loadWorldMeta = (store) => store.get(META);
export async function deleteWorld(store) { await store.delete(CURRENT); await store.delete(META); }
