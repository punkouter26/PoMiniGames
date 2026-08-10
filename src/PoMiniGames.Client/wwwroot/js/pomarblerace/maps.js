// maps.js — the marble-race map registry, and the single track interface the game speaks to.
//
// Slots 1-9. Slot 1 is the original procedural chute, slot 2 is the authored marble_track.glb
// course, and 3-9 are free for further GLB courses. TO ADD A MAP, see ADDING A GLB MAP below —
// it is a handful of lines here plus one bake, with nothing to change in game.js.
//
// ── THE TRACK INTERFACE ─────────────────────────────────────────────────────────────────────
// The two existing maps are built on completely different premises. The procedural chute is a
// straight descent whose progress IS its world +Z coordinate. The GLB course spirals back over
// itself, banks to near-vertical and branches, so it has no such coordinate and measures progress
// as arclength along a baked centerline. Rather than teach the game about both, every map is
// presented through one interface keyed on `s` — distance along the course in world units:
//
//   group            THREE.Object3D holding everything the map renders
//   startPositions   Vector3[] — one per marble, in grid order
//   length           total course length in world units
//   finishS          `s` at which a marble is scored as finished
//   overviewTarget   Vector3 the pick-phase camera frames
//   paddles          [{ body, mesh }] driven props whose meshes follow their bodies each frame
//   project(pos, hint, out)  world position -> { s, index, lateral, height }, `index` being an
//                    opaque hint to pass back next frame to keep the search local
//   centerAt/dirAt/rightAt/upAt(s, out)   the local frame at `s`
//   halfWidthAt(s)   half the channel width at `s`
//   lateralOf(proj)  signed position across the channel, 0 centre / ±1 at the wall
//   isOutOfBounds(proj)   has this marble left the course?
//   floorPoint(pos, proj, out)  the point on the floor beneath a marble, for its contact shadow
//   driveMotors()    re-assert any powered obstacle each frame
//   dispose()
//
// OPTIONAL, and absent on maps that have no such feature — the game feature-detects each:
//   inBoost(s)       is `s` on a boost pad?
//   kickers          telegraphed kicker bands (see game.js _applyKickers)
//   regenerate       true if asking for a new track means anything (procedural maps only)
import * as THREE from 'three';
import { generateTrack, TRACK as PROC_TRACK } from './track-procedural.js';
import { loadTrackModel, buildTrack as buildGlbTrack } from './track-glb.js';

/** A fresh, zeroed projection record for a caller to own and reuse. */
export const newProjection = () => ({ s: 0, index: -1, lateral: 0, height: 0 });

// ── procedural adapter ──────────────────────────────────────────────────────────────────────
// The procedural chute predates the interface above and speaks in world +Z. Because it descends
// monotonically in +Z, `s` and `z` are the same number, so this adapter is a thin translation
// rather than a reimplementation — and the original generator is left exactly as it was.
const _c = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _d = new THREE.Vector3();

// How far beneath the floor plane a marble may sit before it counts as off the chute. The
// original test was `y < floorY(z) - 58` in WORLD space; in the local frame the banking is
// already accounted for, so the margin only has to cover a hard bounce.
const PROC_OOB_DROP = 34;
const PROC_OOB_LATERAL = 26;

function adaptProceduralTrack(t) {
  // up = right x dir. The generator publishes dir and right but not up, and for a right-handed
  // basis where right = dir x up, that cross product recovers up exactly.
  const upAt = (s, out) => {
    const d = t.dirAt(s), r = t.rightAt(s);
    return (out || _u).copy(r).cross(d).normalize();
  };
  const halfWidthAt = (s) => t.halfWidthAt(s);

  return {
    group: t.group,
    startPositions: t.startPositions,
    length: t.length,
    finishS: t.finishZ,
    overviewTarget: t.overviewTarget,
    paddles: t.turnstiles,
    kickers: t.kickers,
    regenerate: true,

    project(pos, hint, out) {
      const o = out || newProjection();
      const s = Math.max(0, Math.min(t.length, pos.z));
      const c = t.centerAt(s), r = t.rightAt(s);
      upAt(s, _u);
      const dx = pos.x - c.x, dy = pos.y - c.y, dz = pos.z - c.z;
      o.s = s;
      o.index = 0;                                     // no hint needed: the lookup is O(1)
      o.lateral = dx * r.x + dy * r.y + dz * r.z;
      o.height = dx * _u.x + dy * _u.y + dz * _u.z;
      return o;
    },

    centerAt: (s, out) => (out ? out.copy(t.centerAt(s)) : t.centerAt(s)),
    dirAt: (s, out) => (out ? out.copy(t.dirAt(s)) : t.dirAt(s)),
    rightAt: (s, out) => (out ? out.copy(t.rightAt(s)) : t.rightAt(s)),
    upAt,
    halfWidthAt,
    lateralOf: (proj) => Math.max(-1.4, Math.min(1.4, proj.lateral / Math.max(1, halfWidthAt(proj.s)))),
    isOutOfBounds: (proj) =>
      proj.height < -PROC_OOB_DROP || Math.abs(proj.lateral) > halfWidthAt(proj.s) + PROC_OOB_LATERAL,
    floorPoint: (pos, proj, out) => {
      upAt(proj.s, _u);
      return out.set(pos.x, pos.y, pos.z).addScaledVector(_u, -proj.height + 0.06);
    },
    inBoost: (s) => t.inBoost(s),
    driveMotors: () => t.driveMotors(),
    dispose: () => t.dispose(),
  };
}

// ── registry ────────────────────────────────────────────────────────────────────────────────
//
// ADDING A GLB MAP (slots 3-9):
//   1. Drop the model in wwwroot/models/.
//   2. Point scripts/bake-marble-track.mjs at it and run it — that emits the centerline and the
//      collision shell the course needs. (The baker currently hard-codes the one model's paths
//      and its course order; a second course means parameterising those.)
//   3. Add an entry below with the next free `id`.
// `load` is awaited once before the first build and may return anything the map needs; whatever
// it resolves to is handed back to `build` as `asset`.
const MAPS = [
  {
    id: 1,
    name: 'Neon Chute',
    blurb: 'The original procedurally generated run — a different track every race, with boost pads, rumble strips and the Gauntlet.',
    load: () => Promise.resolve(null),
    build: (world, materials, marbleCount, _asset, seed) =>
      adaptProceduralTrack(generateTrack(world, materials, seed >>> 0, marbleCount)),
  },
  {
    id: 2,
    name: 'Spiral Works',
    blurb: 'An authored course: a four-turn descending helix into split lanes, a funnel, two banked loops and a hazard fan.',
    load: () => loadTrackModel(),
    build: (world, materials, marbleCount, asset) => buildGlbTrack(world, materials, marbleCount, asset),
  },
];

/** Every registered map, in slot order. */
export const MAP_LIST = MAPS;

/** The slot the game opens on when nothing has been chosen. */
export const DEFAULT_MAP_ID = 2;

/** Look a map up by slot id, falling back to the default rather than throwing. */
export function mapById(id) {
  return MAPS.find((m) => m.id === Number(id)) || MAPS.find((m) => m.id === DEFAULT_MAP_ID) || MAPS[0];
}

/** Slot ids and names, for the host's map picker. */
export function mapMenu() {
  return MAPS.map((m) => ({ id: m.id, name: m.name, blurb: m.blurb }));
}
