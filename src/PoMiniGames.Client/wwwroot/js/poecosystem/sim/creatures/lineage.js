// lineage.js — who begat whom. One record per creature that has ever been born (or was
// present at creation), kept after death so a family tree can be walked back through
// the generations and forward to living descendants. Pure bookkeeping: no rule reads it
// and no RNG stream is touched, so a world stays bit-identical with it on or off.
//
// Records are keyed by entity handle (index | gen << 16), which is unique for the life of
// a world, and the snapshot carries the whole map so Resume keeps the dynasties.
import { NONE } from '../core/entities.js';

const DESCENDANT_CAP = 2000;

export function createLineage({ cap = 6000 } = {}) {
  let records = new Map();      // handle → record, insertion order = birth order
  let children = new Map();     // parent handle → [child handles]
  let dead = 0;

  const link = (parent, child) => {
    if (parent === NONE || parent === undefined) return;
    const list = children.get(parent);
    if (list) list.push(child); else children.set(parent, [child]);
  };

  function evict() {
    // Forget the oldest dead records first; the living are never dropped, and a dead
    // parent that is still referenced by a child's record simply resolves to "unknown".
    for (const [h, r] of records) {
      if (dead <= cap * 0.9) break;
      if (r.died < 0) continue;
      records.delete(h); children.delete(h); dead--;
    }
  }

  const api = {
    get count() { return records.size; },
    born({ handle, name, species, sex, mother, father, tick }) {
      records.set(handle, { h: handle, name, species, sex, mother: mother ?? NONE, father: father ?? NONE, born: tick, died: -1, cause: '' });
      link(mother, handle); link(father, handle);
    },
    died(handle, tick, cause) {
      const r = records.get(handle);
      if (!r || r.died >= 0) return;
      r.died = tick; r.cause = cause;
      if (++dead > cap) evict();
    },
    rename(handle, name) { const r = records.get(handle); if (r) r.name = name; },
    get: (handle) => records.get(handle) ?? null,
    childrenOf: (handle) => children.get(handle) ?? [],
    /** Ancestors two generations up, children, sibling and descendant counts. */
    tree(handle) {
      const self = records.get(handle);
      if (!self) return null;
      const rec = (h) => (h === NONE || h === undefined ? null : records.get(h) ?? null);
      const mother = rec(self.mother); const father = rec(self.father);
      const grand = [
        mother ? rec(mother.mother) : null, mother ? rec(mother.father) : null,
        father ? rec(father.mother) : null, father ? rec(father.father) : null,
      ];
      const kids = api.childrenOf(handle).map(rec).filter(Boolean);
      // Siblings are counted per parent, so a full sibling counts twice: exact for the
      // common case of one litter per pair, and a headline number either way.
      let siblings = 0;
      for (const p of [self.mother, self.father]) if (p !== NONE) siblings += api.childrenOf(p).filter(h => h !== handle).length;
      let descendants = 0;
      const seen = new Set([handle]); const queue = [handle];
      while (queue.length && descendants < DESCENDANT_CAP) {
        const h = queue.shift();
        for (const c of api.childrenOf(h)) { if (seen.has(c)) continue; seen.add(c); descendants++; queue.push(c); }
      }
      let generation = 0;
      for (let r = self; r && (r.mother !== NONE || r.father !== NONE) && generation < 40; generation++) r = rec(r.mother) ?? rec(r.father);
      return { self, mother, father, grandparents: grand, children: kids, siblings, descendants, generation };
    },
    getAncestorGrievance(handle) {
      const self = records.get(handle);
      if (!self) return null;
      const rec = (h) => (h === NONE || h === undefined ? null : records.get(h) ?? null);
      const mother = rec(self.mother);
      const father = rec(self.father);
      if (mother && mother.died >= 0 && mother.cause && mother.cause.includes('wolf')) {
        return `mother ${mother.name} was slain by wolves`;
      }
      if (father && father.died >= 0 && father.cause && father.cause.includes('wolf')) {
        return `father ${father.name} was slain by wolves`;
      }
      if (mother && mother.died >= 0 && mother.cause && (mother.cause.includes('combat') || mother.cause.includes('war'))) {
        return `mother ${mother.name} fell in tribal battle`;
      }
      if (father && father.died >= 0 && father.cause && (father.cause.includes('combat') || father.cause.includes('war'))) {
        return `father ${father.name} fell in tribal battle`;
      }
      return null;
    },
    getState() { return { records: [...records.values()].map(r => ({ ...r })), dead }; },
    setState(s) {
      records = new Map(); children = new Map(); dead = 0;
      for (const r of s?.records ?? []) {
        records.set(r.h, { ...r });
        link(r.mother, r.h); link(r.father, r.h);
        if (r.died >= 0) dead++;
      }
    },
  };
  return api;
}
