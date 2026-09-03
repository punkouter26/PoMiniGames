// snapshot.js — the save file (plan decision 6). One structured-clone-able object: the
// seed and terrain hash (the terrain itself is regenerated), every piece of mutable sim
// state, and the settled physics props. A different schema or a different terrain
// generator is refused — the host then offers a New World rather than dropping
// creatures onto ground that moved.
import { createWorld } from '../world.js';

export const SNAPSHOT_VERSION = 1;

export function snapshotWorld(world) {
  return {
    schemaVersion: SNAPSHOT_VERSION,
    savedAt: Date.now(),
    seed: world.seed,
    terrainHash: world.terrain.hash,
    cap: world.entities.cap,
    tick: world.clock.tick,
    year: world.clock.year(),
    counts: world.stats().counts,
    state: world.getState(),
    props: world.physics.snapshot ? world.physics.snapshot() : [],
  };
}

/** Rebuild a world from a snapshot; null when the snapshot cannot be honoured. */
export function restoreWorld(snap, { physics = null } = {}) {
  if (!snap || typeof snap !== 'object' || snap.schemaVersion !== SNAPSHOT_VERSION || !snap.state) return null;
  const world = createWorld({ seed: snap.seed, caps: { creatureCap: snap.cap }, physics });
  if (world.terrain.hash !== snap.terrainHash) return null;
  world.setState(snap.state);
  if (world.physics.restore) world.physics.restore(snap.props ?? []);
  return world;
}
