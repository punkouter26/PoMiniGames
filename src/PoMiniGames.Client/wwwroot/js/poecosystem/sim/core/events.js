// events.js — the world event log (what the HUD toasts and dashboard show) and a
// tiny synchronous bus for in-sim subscribers (e.g. thoughts listening for deaths).

export function createEventLog(capacity = 200) {
  let items = [];
  let nextId = 1;
  let drainFrom = 0; // id of the first event not yet drained
  const log = {
    get count() { return items.length; },
    push(ev) {
      const entry = { id: nextId++, ...ev };
      items.push(entry);
      if (items.length > capacity) items.splice(0, items.length - capacity);
      return entry;
    },
    all() { return items.slice(); },
    recent(n) { return items.slice(Math.max(0, items.length - n)); },
    /** Events pushed since the last drain (the 2 Hz batch to the host). */
    drain() {
      const out = items.filter(e => e.id >= drainFrom);
      drainFrom = nextId;
      return out;
    },
    clear() { items = []; drainFrom = nextId; },
    getState() { return { items: items.slice(), nextId, drainFrom }; },
    setState(s) { items = (s.items ?? []).slice(); nextId = s.nextId ?? 1; drainFrom = s.drainFrom ?? nextId; },
  };
  return log;
}

export function createBus() {
  const listeners = new Map();
  return {
    on(kind, fn) {
      if (!listeners.has(kind)) listeners.set(kind, []);
      listeners.get(kind).push(fn);
      return () => {
        const arr = listeners.get(kind);
        const at = arr.indexOf(fn);
        if (at >= 0) arr.splice(at, 1);
      };
    },
    emit(kind, payload) {
      const arr = listeners.get(kind);
      if (!arr) return;
      for (const fn of arr.slice()) fn(payload);
    },
  };
}
