// track.js — the authored course. Loads wwwroot/models/marble_track.glb and turns it into the
// rendered scene, the collision world, and the progress line the rest of the game measures
// against.
//
// WHAT REPLACED WHAT. This file used to generate a procedural descending chute whose entire
// contract was "progress = +Z": every system keyed off a single world coordinate. The authored
// course descends in -Y along a winding XZ path and BRANCHES, so that scalar is meaningless
// here. Progress is now ARCLENGTH along a baked centerline (track-path.js, produced offline by
// scripts/bake-marble-track.mjs) and every accessor below is keyed on `s` — world units along
// that line, 0 at the start gate — instead of on z.
//
// WHAT YOU SEE IS NOT WHAT YOU HIT. The rendered scene is the GLB exactly as authored, all
// 35,212 triangles of it. Collision is built from three different sources, and the split is
// deliberate — see chunkedTrimeshes for the measurements that forced it:
//   * The 22 swept channels collide against a BAKED shell (track-collision.js): the reachable
//     surface only — floor top and wall inner faces — decimated along the sweep. 4,572 triangles
//     against the visual 24,460, with no change to any surface a marble can actually touch.
//   * Track-Bowl is a funnel with no ring structure to loft from, so it collides against its own
//     geometry with the downward-facing half culled. Track-Bumper gets no collider at all.
//   * The 27 Obs-* props become PRIMITIVES (cylinder pegs, box gates, crossed-box paddles).
//     Primitives are cheaper, they give clean pinball-style deflection instead of triangle-edge
//     snagging, and the paddles have to be driven bodies anyway — a moving trimesh is not a
//     reliable collider in cannon-es.
// Everything static is split into CHUNK-sized bodies rather than one body per segment, so the
// broadphase can reject on a tight AABB.
//
// NON-TRAPPING, RESTATED. The old chute could promise a marble was never stuck, because it was
// strictly descending and friction was held below tan(slope) everywhere. The authored course
// does NOT have that property: Track-LowerA and Track-LowerB each contain a real uphill hump
// (the near-vertical banked loops), which a stalled marble cannot climb. What IS still
// guaranteed is that no DESCENDING stretch traps: the shallowest sustained slope on the course
// is Track-LowerC at 0.11, and physics.js holds marble<->surface friction below that. Anything
// that stops dead on a hump is caught by game.js's RACE_TIMEOUT failsafe, not by geometry.
// Re-run the baker to see the per-segment slope table.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SCALE, COUNT, ARCLENGTH, POINTS, DIRS, UPS, RIGHTS, HALF_WIDTHS, CUM } from './track-path.js';
import { VERTICES as COL_VERTS, INDICES as COL_INDICES } from './track-collision.js';

const MODEL_URL = 'models/marble_track.glb';

export const TRACK = {
  SCALE,
  MARBLE_R: 1.0,           // BASE radius — the roster scales each marble around this (marbles.js)
  LENGTH: ARCLENGTH * SCALE,
  // The line ends at the lip of Track-LowerC, where the floor simply stops and the Bumper rim
  // encircles open space. Pull the finish back off the lip so a marble is scored while it is
  // still ON the floor rather than in the instant it drops past it.
  FINISH_BACKOFF: 16,
};

TRACK.FINISH_S = TRACK.LENGTH - TRACK.FINISH_BACKOFF;

// The baked paddles turn at ±0.121 rad/s (four revolutions across a 208-second Blender preview
// clip), which is imperceptible at race pace. The animation is discarded and the props are spun
// as kinematic bodies instead; only the SIGN is kept from the GLB, so the pair still
// counter-rotates and the pack cannot just hug one side through the hazard.
const PADDLE_SPEED = 1.5;      // rad/s

// ── module-level model cache ────────────────────────────────────────────────────────────────
// The course is fixed content: unlike the old seeded generator there is nothing to re-roll
// between races, so the GLB is parsed once per page load and the built track is reused.
let _modelPromise = null;

/**
 * Fetch + parse the course model. Safe to call repeatedly; the parse happens once.
 * @returns {Promise<THREE.Group>} the raw glTF scene (unscaled, as authored).
 */
export function loadTrackModel() {
  if (!_modelPromise) {
    _modelPromise = new GLTFLoader().loadAsync(MODEL_URL).then((gltf) => gltf.scene);
  }
  return _modelPromise;
}

// ── centerline sampling ─────────────────────────────────────────────────────────────────────
// All baked arrays are in raw GLB units; everything below works in WORLD units (× SCALE) so no
// call site has to remember which space it is in. Positions and widths scale; the dir/up/right
// bases are unit vectors and do not.
const WORLD_CUM = new Float32Array(COUNT);
for (let i = 0; i < COUNT; i++) WORLD_CUM[i] = CUM[i] * SCALE;

// Uniform grid over the centerline, for the cold-start / marble-teleported lookup. Every frame's
// projection normally starts from the marble's previous index and only scans a short window;
// this is the fallback that finds the line again when there is no usable hint.
const GRID_CELL = 48;
const _grid = new Map();
const _cellKey = (x, y, z) =>
  `${Math.floor(x / GRID_CELL)},${Math.floor(y / GRID_CELL)},${Math.floor(z / GRID_CELL)}`;
for (let i = 0; i < COUNT; i++) {
  const k = _cellKey(POINTS[i * 3] * SCALE, POINTS[i * 3 + 1] * SCALE, POINTS[i * 3 + 2] * SCALE);
  let bucket = _grid.get(k);
  if (!bucket) _grid.set(k, (bucket = []));
  bucket.push(i);
}

/** Squared distance from (x,y,z) to centerline sample i, in world units. */
function distSqToSample(i, x, y, z) {
  const dx = POINTS[i * 3] * SCALE - x;
  const dy = POINTS[i * 3 + 1] * SCALE - y;
  const dz = POINTS[i * 3 + 2] * SCALE - z;
  return dx * dx + dy * dy + dz * dz;
}

/** Nearest sample index by brute grid search — the no-hint path. */
function nearestSampleGlobal(x, y, z) {
  const cx = Math.floor(x / GRID_CELL), cy = Math.floor(y / GRID_CELL), cz = Math.floor(z / GRID_CELL);
  let best = -1, bestD = Infinity;
  // Widen the ring until something is found: a marble in mid-air over the bowl can be several
  // cells clear of every sample.
  for (let r = 1; r <= 6 && best < 0; r++) {
    for (let ax = cx - r; ax <= cx + r; ax++)
      for (let ay = cy - r; ay <= cy + r; ay++)
        for (let az = cz - r; az <= cz + r; az++) {
          const bucket = _grid.get(`${ax},${ay},${az}`);
          if (!bucket) continue;
          for (const i of bucket) {
            const d = distSqToSample(i, x, y, z);
            if (d < bestD) { bestD = d; best = i; }
          }
        }
  }
  if (best >= 0) return best;
  // Nothing within six cells (a marble that fell out of the world entirely) — fall back to a
  // full scan so the caller still gets a defined answer rather than NaN progress.
  for (let i = 0; i < COUNT; i++) {
    const d = distSqToSample(i, x, y, z);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// How far either side of the hint to scan. A marble travelling 150 u/s covers 1.25 world units
// per physics step and samples are ~4 units apart, so ±24 is generous even after several frames
// without an update.
const HINT_WINDOW = 24;

// A GLOBAL search is only ever used to acquire the line for the first time (hint < 0). It must
// NOT be used as a "the marble looks lost, find it again" fallback, which is what this code did
// first and which produced a nonsense standings jump of 1450 units in two seconds.
//
// The reason is the shape of this course: it is a tight descending spiral that passes back over
// itself repeatedly. Turns of the start helix are only ~46 world units apart vertically, and
// Track-Mid sits almost directly above Track-Lane2 — which is 1450 units further along the line.
// So "nearest centerline sample in space" is simply not the same question as "where is this
// marble in the race", and for a marble that has left the track the two answers are routinely on
// different parts of the course.
//
// Keeping the local result instead is both more truthful and self-correcting: a marble that has
// genuinely fallen keeps the last position it actually reached, and isOutOfBounds retires it on
// the same frame rather than teleporting it up the standings first.

/**
 * Project a world position onto the centerline.
 *
 * `out` is REQUIRED to be reused by the caller: this runs once per marble per frame, and over a
 * 101-marble field returning a fresh object here would be ~6000 allocations a second — the same
 * reason marbles.js keeps scratch objects at module scope.
 *
 * @param {number} x @param {number} y @param {number} z
 * @param {number} hint previous sample index, or -1 for none
 * @param {{s:number, index:number, lateral:number, height:number}} out mutated and returned.
 *   `s` is world units along the line; `lateral` is signed offset along the local right axis and
 *   `height` signed offset along the local up axis, both in world units.
 */
export function project(x, y, z, hint, out) {
  let best = -1, bestD = Infinity;
  if (hint >= 0) {
    const lo = Math.max(0, hint - HINT_WINDOW), hi = Math.min(COUNT - 1, hint + HINT_WINDOW);
    for (let i = lo; i <= hi; i++) {
      const d = distSqToSample(i, x, y, z);
      if (d < bestD) { bestD = d; best = i; }
    }
  } else {
    best = nearestSampleGlobal(x, y, z);
    bestD = distSqToSample(best, x, y, z);
  }

  // Refine along the tangent at the nearest sample: the samples are ~4 units apart, so snapping
  // to one would quantise progress into visible steps in the standings.
  const px = POINTS[best * 3] * SCALE, py = POINTS[best * 3 + 1] * SCALE, pz = POINTS[best * 3 + 2] * SCALE;
  const dx = x - px, dy = y - py, dz = z - pz;
  const tx = DIRS[best * 3], ty = DIRS[best * 3 + 1], tz = DIRS[best * 3 + 2];
  let along = dx * tx + dy * ty + dz * tz;
  // Clamp into the neighbouring gaps so the refinement can never jump a whole segment.
  const back = best > 0 ? WORLD_CUM[best] - WORLD_CUM[best - 1] : 0;
  const fwd = best < COUNT - 1 ? WORLD_CUM[best + 1] - WORLD_CUM[best] : 0;
  along = Math.max(-back, Math.min(fwd, along));

  const rx = RIGHTS[best * 3], ry = RIGHTS[best * 3 + 1], rz = RIGHTS[best * 3 + 2];
  const ux = UPS[best * 3], uy = UPS[best * 3 + 1], uz = UPS[best * 3 + 2];
  out.s = WORLD_CUM[best] + along;
  out.index = best;
  out.lateral = dx * rx + dy * ry + dz * rz;
  out.height = dx * ux + dy * uy + dz * uz;
  return out;
}

/** A fresh, zeroed projection record for a caller to own and reuse. */
export const newProjection = () => ({ s: 0, index: -1, lateral: 0, height: 0 });

/** Sample index at arclength `s` (world units), by binary search over the cumulative table. */
function indexAt(s) {
  let lo = 0, hi = COUNT - 1;
  if (s <= 0) return 0;
  if (s >= WORLD_CUM[hi]) return hi;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (WORLD_CUM[mid] <= s) lo = mid; else hi = mid;
  }
  return lo;
}

// Interpolating accessors. `out` is always caller-supplied or a shared scratch: these run for
// every marble every frame and allocating here would be thousands of vectors per second.
function lerpVec(arr, s, out, scaled) {
  const i = indexAt(s);
  const j = Math.min(COUNT - 1, i + 1);
  const span = WORLD_CUM[j] - WORLD_CUM[i];
  const t = span > 1e-6 ? Math.max(0, Math.min(1, (s - WORLD_CUM[i]) / span)) : 0;
  const k = scaled ? SCALE : 1;
  out.set(
    (arr[i * 3] + (arr[j * 3] - arr[i * 3]) * t) * k,
    (arr[i * 3 + 1] + (arr[j * 3 + 1] - arr[i * 3 + 1]) * t) * k,
    (arr[i * 3 + 2] + (arr[j * 3 + 2] - arr[i * 3 + 2]) * t) * k,
  );
  return out;
}

// One scratch PER accessor, never shared. Callers routinely hold two of these at once — the
// frame loop takes centerAt() and dirAt() together to aim the camera — so a shared scratch would
// silently hand back the same vector twice.
const _scratchCenter = new THREE.Vector3();
const _scratchDir = new THREE.Vector3();
const _scratchRight = new THREE.Vector3();
const _scratchUp = new THREE.Vector3();

/** Centerline (floor-centre) point at arclength `s`. */
export const centerAt = (s, out) => lerpVec(POINTS, s, out || _scratchCenter, true);
/** Unit forward tangent at `s`. */
export const dirAt = (s, out) => lerpVec(DIRS, s, out || _scratchDir, false).normalize();
/** Unit lateral axis at `s` (track-local right). */
export const rightAt = (s, out) => lerpVec(RIGHTS, s, out || _scratchRight, false).normalize();
/** Unit up axis at `s`; carries the authored banking. */
export const upAt = (s, out) => lerpVec(UPS, s, out || _scratchUp, false).normalize();

/** Half channel width at `s`, world units. */
export function halfWidthAt(s) {
  const i = indexAt(s);
  const j = Math.min(COUNT - 1, i + 1);
  const span = WORLD_CUM[j] - WORLD_CUM[i];
  const t = span > 1e-6 ? Math.max(0, Math.min(1, (s - WORLD_CUM[i]) / span)) : 0;
  return (HALF_WIDTHS[i] + (HALF_WIDTHS[j] - HALF_WIDTHS[i]) * t) * SCALE;
}

// How far beneath the floor plane, or how far outside the channel, a marble must be before it
// counts as having left the course. EITHER is enough — see isOutOfBounds. OOB_DROP is generous
// against the ~8-unit wall height so a marble bouncing hard in a banked turn is not retired for
// one deep frame; OOB_LATERAL likewise leaves room for a marble climbing past the flat width of
// a bank.
const OOB_DROP = 24;
const OOB_LATERAL = 20;

// ── geometry → collision ────────────────────────────────────────────────────────────────────
// NOTE on scale: the loaded scene's ROOT is scaled by SCALE before updateMatrixWorld, so every
// mesh's matrixWorld already carries it. Both helpers below therefore transform by matrixWorld
// and stop — applying SCALE again here would build every collider at 16x the geometry it is
// supposed to match.

// Edge length of a collision chunk, world units. Measured U-curve on this course (101 marbles,
// ms per physics step): 24 -> 66, 48 -> 52, 64 -> 39, 80 -> 47, 160 -> 104. Too small and the
// per-pair narrowphase overhead multiplies; too large and each query hands back a pile of
// triangles to test. 64 sits at the bottom.
const CHUNK = 64;

/**
 * Restore the spatial early-out in a Trimesh's octree query.
 *
 * cannon-es 0.20 ships Octree.aabbQuery with its own early-out commented out (the source still
 * carries the disabled lines and a "@todo unwrap recursion into a queue" note next to them). As
 * shipped it pushes every child onto the queue unconditionally, so a query walks the ENTIRE tree
 * and costs O(total nodes) instead of O(log n). Since sphere-vs-trimesh issues one query per
 * marble per chunk per step, that single missing test dominated the whole frame: 40.5 ms of a
 * 43.8 ms step was narrowphase, for only 90 actual contacts.
 *
 * The check is sound because Octree.insert only ever stores an element on a node whose AABB
 * CONTAINS that element's AABB — so a node that does not overlap the query cannot hold anything
 * that does, and neither can its descendants. This is the library's own intended behaviour,
 * restored; it is not a change in collision semantics, and the contact set is identical.
 */
function patchOctreeQuery(trimesh) {
  const tree = trimesh.tree;
  tree.aabbQuery = function aabbQuery(aabb, result) {
    const queue = [this];
    while (queue.length) {
      const node = queue.pop();
      if (!node.aabb.overlaps(aabb)) continue;
      if (node.data.length) Array.prototype.push.apply(result, node.data);
      for (let i = 0; i < node.children.length; i++) queue.push(node.children[i]);
    }
    return result;
  };
  return trimesh;
}

/**
 * Split a soup of world-space triangles into a uniform spatial grid and return one
 * CANNON.Trimesh per non-empty cell.
 *
 * WHY, AND DO NOT COLLAPSE THIS BACK. cannon-es's sphere-vs-trimesh narrowphase asks the
 * trimesh's internal Octree which triangles lie near the sphere, then runs seven sub-tests on
 * every triangle it gets back. Two things made that unaffordable with one body per authored
 * segment, and chunking fixes both: each octree stays small, and the chunk AABBs are tight
 * enough that the broadphase discards nearly all of them before the narrowphase is reached (a
 * whole four-turn helix in one body has an AABB a marble overlaps for its entire descent).
 *
 * Triangles are binned by CENTROID, so each belongs to exactly one chunk and none is duplicated
 * or dropped — the union of the chunks is the input surface exactly.
 *
 * @param {ArrayLike<number>} wx @param {ArrayLike<number>} wy @param {ArrayLike<number>} wz
 *   world-space vertex components
 * @param {ArrayLike<number>} indices triangle indices
 * @param {(a:number,b:number,c:number)=>boolean} [keep] optional per-triangle filter
 */
function chunkedTrimeshes(wx, wy, wz, indices, keep) {
  const triCount = indices.length / 3;
  const cells = new Map();
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    if (keep && !keep(a, b, c)) continue;
    const gx = (wx[a] + wx[b] + wx[c]) / 3, gy = (wy[a] + wy[b] + wy[c]) / 3, gz = (wz[a] + wz[b] + wz[c]) / 3;
    const key = `${Math.floor(gx / CHUNK)},${Math.floor(gy / CHUNK)},${Math.floor(gz / CHUNK)}`;
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = []));
    cell.push(t);
  }

  const out = [];
  for (const tris of cells.values()) {
    const verts = new Array(tris.length * 9);
    const ind = new Array(tris.length * 3);
    let vi = 0;
    for (let n = 0; n < tris.length; n++) {
      const t = tris[n];
      for (let k = 0; k < 3; k++) {
        const sIdx = indices[t * 3 + k];
        verts[vi * 3] = wx[sIdx]; verts[vi * 3 + 1] = wy[sIdx]; verts[vi * 3 + 2] = wz[sIdx];
        ind[n * 3 + k] = vi;
        vi++;
      }
    }
    // CANNON.Trimesh stores indices in an Int16Array, so a chunk may hold at most 32767/3 ~ 10922
    // triangles before indices silently wrap and the collider becomes garbage geometry. Chunking
    // keeps us orders of magnitude below that; this asserts it rather than trusting it.
    if (vi > 32767) throw new Error(`marble track: collision chunk has ${vi} vertices, past cannon-es Int16 index limit - reduce CHUNK`);
    out.push(patchOctreeQuery(new CANNON.Trimesh(verts, ind)));
  }
  return out;
}

/** World-space vertex components + indices for a three.js mesh, as flat arrays. */
function worldTriangles(mesh) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const m = mesh.matrixWorld;
  const v = new THREE.Vector3();
  const wx = new Float64Array(pos.count), wy = new Float64Array(pos.count), wz = new Float64Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m);
    wx[i] = v.x; wy[i] = v.y; wz[i] = v.z;
  }
  let indices;
  if (geo.index) indices = geo.index.array;
  else { indices = new Uint32Array(pos.count); for (let i = 0; i < pos.count; i++) indices[i] = i; }
  return { wx, wy, wz, indices };
}

/** Axis-aligned world extents of a mesh. */
function worldBox(mesh) {
  mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
}

/**
 * Build the course: scene graph, collision bodies, and the progress accessors the game measures
 * against. The model must already be loaded — call loadTrackModel() first.
 *
 * @param {CANNON.World} world
 * @param {object} materials from physics.js createWorld()
 * @param {number} marbleCount size of the starting field
 * @param {THREE.Group} model the parsed glTF scene from loadTrackModel()
 */
export function buildTrack(world, materials, marbleCount, model) {
  const group = new THREE.Group();
  const bodies = [];
  const paddles = [];   // { body, mesh } — visual node driven from its kinematic body each frame
  const motors = [];

  // One shared instance of the model per page: clone so a rebuild cannot mutate the cache.
  const scene = model.clone(true);
  scene.scale.setScalar(SCALE);
  scene.updateMatrixWorld(true);

  // The authored materials carry the embedded textures; only the sampling needs fixing up.
  // scene.js raises THREE.Texture.DEFAULT_ANISOTROPY to the hardware ceiling, but GLTFLoader
  // builds its textures from the file's own sampler settings and never sees that default, so
  // without this the track surfaces alias into crawling moiré at grazing camera angles — the
  // same shimmer the procedural textures were fixed for.
  const aniso = THREE.Texture.DEFAULT_ANISOTROPY;
  const seenTex = new Set();

  const trackMeshes = [];
  const propNodes = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of mats) {
      if (mat && mat.map && !seenTex.has(mat.map)) {
        seenTex.add(mat.map);
        mat.map.anisotropy = aniso;
        mat.map.needsUpdate = true;
      }
    }
    if (/^Track-/.test(o.name)) trackMeshes.push(o);
    else if (/^Obs-/.test(o.name)) propNodes.push(o);
  });

  // ── static track surfaces ──
  // One body per CHUNK, not per authored segment — see chunkedTrimeshes for why that distinction
  // is worth ~14x of the frame budget. Each chunk is its own body so the broadphase can reject it
  // on a tight AABB.
  const addSurface = (shape) => {
    const body = new CANNON.Body({ mass: 0, material: materials.surface });
    body.addShape(shape);
    world.addBody(body);
    bodies.push(body);
  };

  // The 22 swept channels collide against the BAKED shell, not the rendered mesh — 4,572
  // triangles instead of 24,460, being only the surface a marble can actually reach and
  // decimated along the sweep. See track-collision.js and the baker for what that costs in
  // fidelity (essentially nothing) and buys in frame time (5.3x fewer triangles to test).
  {
    const n = COL_VERTS.length / 3;
    const cx = new Float64Array(n), cy = new Float64Array(n), cz = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      cx[i] = COL_VERTS[i * 3] * SCALE;
      cy[i] = COL_VERTS[i * 3 + 1] * SCALE;
      cz[i] = COL_VERTS[i * 3 + 2] * SCALE;
    }
    for (const shape of chunkedTrimeshes(cx, cy, cz, COL_INDICES)) addSurface(shape);
  }

  for (const mesh of trackMeshes) {
    // Track-Bowl is a funnel, not a swept channel, so the baker has no ring structure to loft a
    // shell from and it collides against its rendered geometry. Its reachable surface is the
    // inside of the cone, whose normals all point upward, so a single normal test culls the
    // underside exactly.
    if (mesh.name !== 'Track-Bowl') continue;
    const { wx, wy, wz, indices } = worldTriangles(mesh);
    const upwardFacing = (a, b, c) => {
      const e1x = wx[b] - wx[a], e1y = wy[b] - wy[a], e1z = wz[b] - wz[a];
      const e2x = wx[c] - wx[a], e2y = wy[c] - wy[a], e2z = wz[c] - wz[a];
      return e1z * e2x - e1x * e2z > 0;   // the +Y component of (e1 x e2)
    };
    for (const shape of chunkedTrimeshes(wx, wy, wz, indices, upwardFacing)) addSurface(shape);
  }
  // Track-Bumper is deliberately absent: it is a free-standing decorative rim encircling open
  // space BEYOND the finish line. There is no floor inside it and marbles freeze at
  // TRACK.FINISH_S before reaching it, so a collider bought nothing and cost the broadphase a
  // 274-unit-wide AABB parked over the end of the course. Rendered, not collided.

  // ── obstacle primitives ──
  for (const node of propNodes) {
    const box = worldBox(node);
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    if (/^Obs-Peg/.test(node.name)) {
      // Authored as a short vertical cylinder. cannon-es builds Cylinder along +Y, which matches
      // the authored orientation, so no shape rotation is needed.
      const r = Math.max(size.x, size.z) / 2;
      const body = new CANNON.Body({ mass: 0, material: materials.obstacle });
      body.addShape(new CANNON.Cylinder(r, r, size.y, 10));
      body.position.set(centre.x, centre.y, centre.z);
      world.addBody(body);
      bodies.push(body);
    } else if (/^Obs-Gate/.test(node.name)) {
      const body = new CANNON.Body({ mass: 0, material: materials.obstacle });
      body.addShape(new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2)));
      body.position.set(centre.x, centre.y, centre.z);
      world.addBody(body);
      bodies.push(body);
    } else if (/^Obs-Paddle/.test(node.name)) {
      // Two crossed blades, each 5.8 x 1.6 x 0.3 in authored units, sitting ABOVE the node
      // origin (the mesh spans y 0..1.6), so the pivot is the node position and the shapes are
      // offset up by half the blade height.
      const pivot = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
      const bladeLen = 2.9 * SCALE, bladeH = 1.6 * SCALE, bladeT = 0.15 * SCALE;
      // KINEMATIC, not a hinged dynamic body on a motor. The old Gauntlet rotors were motorised
      // hinges and needed their target re-armed every single frame, because cannon-es zeroes a
      // motor the moment something stalls it — a marble wedged against a blade could stop the
      // rotor dead, and a stopped obstacle is exactly the thing that can trap the pack. A
      // kinematic body has infinite mass: it drives the pack and nothing in the pack can drive
      // it, so "the paddle always sweeps clear again" holds by construction rather than by
      // repair. Marbles still take a proper impulse off it — cannon-es feeds a kinematic body's
      // velocity into contact resolution.
      const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: materials.spinner });
      const lift = new CANNON.Vec3(0, bladeH / 2, 0);
      body.addShape(new CANNON.Box(new CANNON.Vec3(bladeLen, bladeH / 2, bladeT)), lift);
      body.addShape(new CANNON.Box(new CANNON.Vec3(bladeT, bladeH / 2, bladeLen)), lift);
      body.position.set(pivot.x, pivot.y, pivot.z);
      // Direction is taken from the GLB's baked clip (the pair counter-rotates); the RATE is
      // not — see PADDLE_SPEED.
      const sign = /-1$/.test(node.name) ? -1 : 1;
      body.angularVelocity.set(0, sign * PADDLE_SPEED, 0);
      world.addBody(body);
      bodies.push(body);
      motors.push({ body, speed: sign * PADDLE_SPEED });

      // The prop is now driven by its body, so detach it from the authored transform and let
      // the frame loop write it. Reparenting to the group keeps it out of the scaled subtree,
      // so body-space and mesh-space agree.
      node.removeFromParent();
      node.scale.setScalar(SCALE);
      group.add(node);
      paddles.push({ body, mesh: node });
    }
  }

  group.add(scene);

  // ── starting grid ──
  // Laid out across the start straight in rows, widest first: the field has to fit the AUTHORED
  // channel, which is 40 units across at the gate rather than the old chute's fixed 64, so the
  // column count is derived from the real half-width at each row's own arclength.
  const COL_SPACING = 3.4;                       // > one marble diameter plus margin
  // Rows were 8 units apart, which packed the whole 101-marble field into 88 units of a start
  // straight that is nearly 1000 long. The authored channel narrows from 40 units wide at the
  // gate to 24 within the first 130, and a pack that dense arriving at that taper jams: the tail
  // was measured sitting motionless for tens of seconds, and freed itself the instant the marbles
  // around it were removed. Spreading the grid out costs nothing and lets the field feed through.
  const ROW_GAP = 14;                            // world units of arclength between rows
  const startPositions = [];
  {
    const p = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
    let slot = 0, row = 0;
    while (slot < marbleCount) {
      const s = 6 + row * ROW_GAP;
      const usable = Math.max(6, halfWidthAt(s) * 2 - 6);   // clear of both walls
      const cols = Math.max(1, Math.min(18, Math.floor(usable / COL_SPACING)));
      const span = Math.min(usable, (cols - 1) * COL_SPACING);
      centerAt(s, p); rightAt(s, right); upAt(s, up);
      for (let c = 0; c < cols && slot < marbleCount; c++, slot++) {
        const lateral = cols === 1 ? 0 : (c / (cols - 1) - 0.5) * span;
        startPositions.push(p.clone()
          .addScaledVector(right, lateral)
          .addScaledVector(up, TRACK.MARBLE_R * 1.25 + 0.6));
      }
      row++;
    }
  }
  // Put the player's marble (index 0, the red one) in the MIDDLE of the pack rather than the
  // front-left corner — it starts on an even footing with a race in front of and behind it.
  const centralSlot = Math.floor(startPositions.length / 2);
  if (centralSlot > 0) {
    const tmp = startPositions[0];
    startPositions[0] = startPositions[centralSlot];
    startPositions[centralSlot] = tmp;
  }

  const overviewTarget = centerAt(0, new THREE.Vector3());

  return {
    group,
    bodies,
    paddles,
    startPositions,
    length: TRACK.LENGTH,
    finishS: TRACK.FINISH_S,
    overviewTarget,

    /**
     * Project a body position onto the centerline. Pass the caller's previous index as `hint`
     * to keep this to a short local scan — see project().
     */
    project: (pos, hint, out) => project(pos.x, pos.y, pos.z, hint === undefined ? -1 : hint, out),

    centerAt: (s, out) => centerAt(s, out),
    dirAt: (s, out) => dirAt(s, out),
    rightAt: (s, out) => rightAt(s, out),
    upAt: (s, out) => upAt(s, out),
    halfWidthAt,

    /**
     * Signed lateral position across the channel: 0 = centerline, ±1 = at the wall. Clamped a
     * little past 1 because a marble riding a banked turn legitimately sits outside the flat
     * half-width. Drives the HUD edge gauge.
     */
    lateralOf: (proj) => {
      const hw = halfWidthAt(proj.s);
      return Math.max(-1.4, Math.min(1.4, proj.lateral / Math.max(1, hw)));
    },

    /**
     * Has this marble left the course?
     *
     * Judged in the track's LOCAL frame, which is what makes a single height test correct here.
     * A world-Y test cannot work on a course that banks to near-vertical — a marble riding the
     * Track-LowerA wall-of-death is far below the centerline in world Y while being perfectly in
     * bounds. In the local frame the banking is already accounted for, so a marble on ANY part of
     * the surface reads height ~ +1 (its own radius) and one that has left it reads sharply
     * negative.
     *
     * These are deliberately OR'd. They were AND'd at first, which sounds safer and is not: a
     * marble dropping straight through a gap in the floor — the splitter mouths do have them —
     * falls with lateral ~ 0, satisfied the height test alone, and so was never retired at all.
     * It just kept falling while still holding its place in the standings.
     */
    isOutOfBounds: (proj) => proj.height < -OOB_DROP || Math.abs(proj.lateral) > halfWidthAt(proj.s) + OOB_LATERAL,

    /**
     * Floor point directly beneath a marble, for its contact shadow. Projected onto the local
     * floor PLANE rather than to a world-Y height, so the shadow stays planted on banked turns.
     */
    floorPoint: (pos, proj, out) => {
      const up = upAt(proj.s, _scratchUp);
      return out.set(pos.x, pos.y, pos.z).addScaledVector(up, -proj.height + 0.06);
    },

    /**
     * Re-assert the paddles' spin. The bodies are kinematic so nothing in the pack can slow
     * them, but cannon-es integrates a kinematic body's angular velocity into its quaternion and
     * this keeps the rate exact against any drift.
     */
    driveMotors() {
      for (const m of motors) m.body.angularVelocity.set(0, m.speed, 0);
    },

    dispose() {
      for (const b of bodies) world.removeBody(b);
      // NOTHING three.js is freed here, and that is deliberate. THREE.Object3D.clone() copies the
      // node graph but SHARES geometries and materials with its source, and the source is the
      // module-level cached glTF scene that loadTrackModel() hands to every later build. Disposing
      // them here would free the GPU buffers out from under that cache: this race would end fine
      // and the next visit to the page would build a track out of destroyed geometry and render
      // nothing. The cache is page-lifetime by design, so its resources outlive any one track.
    },
  };
}
