// entities.js — structure-of-arrays creature store (plan decision 5).
//
// Capacity is fixed at creation; allocation never grows. Indices are dense-ish
// (free-list LIFO) and iteration is always ascending index order so every rule
// that walks creatures is deterministic. External references use handles
// (index | gen << 16) so a slot reused after a death cannot be mistaken for the
// creature that died there.
import { TRAITS } from './config.js';

export const NONE = -1;

const F32 = ['x', 'y', 'z', 'yaw', 'vx', 'vz', 'age', 'hunger', 'thirst', 'health', 'scale', 'nudgeDelta'];
const U8 = ['species', 'lifeStage', 'state', 'goal', 'sex', 'alive', 'lastThoughtSource'];
const I8 = ['nudgeTrait'];
const I32 = ['mother', 'father', 'target', 'leader', 'homeTile', 'memFoodTile', 'memFoodTick', 'memWaterTile', 'memWaterTick', 'birthTick', 'gestationEndTick', 'lastMateTick', 'goalSince', 'nudgeEndTick', 'alertTick', 'pendingFather'];

export function createEntities(cap) {
  const e = { cap, high: 0, count: 0 };
  for (const c of F32) e[c] = new Float32Array(cap);
  for (const c of U8) e[c] = new Uint8Array(cap);
  for (const c of I8) e[c] = new Int8Array(cap);
  for (const c of I32) e[c] = new Int32Array(cap);
  e.traits = new Float32Array(cap * TRAITS.length);
  e.gen = new Uint16Array(cap);
  e.names = new Array(cap).fill('');
  e.lastThought = new Array(cap).fill('');

  const free = [];

  function reset(i) {
    for (const c of F32) e[c][i] = 0;
    for (const c of U8) e[c][i] = 0;
    for (const c of I8) e[c][i] = NONE;
    for (const c of I32) e[c][i] = NONE;
    e.traits.fill(0, i * TRAITS.length, (i + 1) * TRAITS.length);
    e.names[i] = '';
    e.lastThought[i] = '';
  }

  e.alloc = () => {
    let i;
    if (free.length > 0) i = free.pop();
    else if (e.high < cap) i = e.high++;
    else return -1;
    reset(i);
    e.alive[i] = 1;
    e.count++;
    return i;
  };

  e.free = (i) => {
    if (!e.alive[i]) return;
    e.alive[i] = 0;
    e.gen[i] = (e.gen[i] + 1) & 0xFFFF;
    e.count--;
    free.push(i);
  };

  e.handle = (i) => (i | (e.gen[i] << 16));
  e.resolve = (h) => {
    if (h === NONE || h === undefined) return NONE;
    const i = h & 0xFFFF;
    const g = (h >>> 16) & 0xFFFF;
    return i < cap && e.alive[i] && e.gen[i] === g ? i : NONE;
  };

  e.forEachAlive = (fn) => {
    for (let i = 0; i < e.high; i++) if (e.alive[i]) fn(i);
  };

  /** Typed-array column names, for the frame encoder and snapshot code. */
  e.columns = () => [...F32, ...U8, ...I8, ...I32, 'traits', 'gen'];

  /** Snapshot support: the free list must be restored in order to stay deterministic. */
  e.getFreeList = () => free.slice();
  e.setFreeList = (list) => { free.length = 0; for (const i of list) free.push(i); };

  return e;
}
