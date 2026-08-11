// bake-marble-track.mjs — offline baker for the PoMarbleRace authored courses.
//
//   node scripts/bake-marble-track.mjs           # course1 — Spiral Works (map 2)
//   node scripts/bake-marble-track.mjs course2   # course2 — Grand Spiral (map 3)
//
// Reads the selected course's GLB from src/PoMiniGames.Client/wwwroot/models/ and writes its
// centerline + collision shell into src/PoMiniGames.Client/wwwroot/js/pomarblerace/. See the
// COURSES registry below; everything after it is course-agnostic.
//
// WHY THIS EXISTS. The authored course descends in -Y along a winding XZ path and BRANCHES
// (Split-A/B/C, the 3-wide Lane2 fan, the 3-wide hazard fan, and the Catch/Penalty pair). The
// game needs a single monotonic progress scalar for standings, camera framing, finish detection
// and out-of-bounds culling, and it needs a local track frame (up / right) for steering and the
// HUD edge gauge. Neither can be read off the mesh at runtime cheaply, so we bake a centerline
// polyline here, once, and ship it as data.
//
// HOW THE CENTERLINE IS RECOVERED. Every Track-* channel in this GLB is a swept U-section
// emitted ring-major: taking the vertex buffer's positions in order and de-duplicating yields
// groups of exactly 8 vertices per ring, always in the same slot order:
//
//     0,1 = floor underside pair      4,5 = floor TOP pair      <- marbles roll here
//     2,7 = wall-top outer pair       3,6 = wall-top inner pair
//
// so the floor centerline is midpoint(v4, v5), the channel width is |v4 - v5|, and the (banked)
// up axis is midpoint(v3,v6) - midpoint(v4,v5) normalised. This is exact, not a fit. The baker
// ASSERTS the 8-vertex grouping and the resulting smoothness, so if the GLB is ever re-exported
// with a different vertex order the bake fails loudly instead of emitting a garbage path.
//
// Track-Bowl (a funnel) and Track-Bumper (a rim) are not swept channels and are handled as
// explicit hand-written links below — see BOWL_LINK.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = 'src/PoMiniGames.Client/wwwroot/models';
const JS = 'src/PoMiniGames.Client/wwwroot/js/pomarblerace';

// ── course registry ─────────────────────────────────────────────────────────────────────────
// One entry per authored GLB course. Everything below this block is course-agnostic: the ring
// decoding, the centerline bake, the splitter-mouth bridging and the collision shell all work off
// whichever entry is selected, so adding a third course is an entry here plus a bake — no change
// to the machinery.
//
//   node scripts/bake-marble-track.mjs           # course1, the default
//   node scripts/bake-marble-track.mjs course2
//
// `scale` is per course: the game world is 1 unit = 1 cm with a radius-1 marble, so it converts
// the authored units into something a marble fits in. `course` is the segment order, resolved
// from exact endpoint coincidence — `main` names the segment carrying the progress line, `alt`
// names segments that are collidable and rendered but measured by projecting onto the main line.
const COURSES = {
  // Spiral Works (map 2). Authored at roughly 1 unit = 1 "marble-ish", raw lanes 4.25-24 units
  // across; 4x puts the narrowest lane (Lane2) at 17 units — eight marbles abreast — and the
  // start straight at 40.
  //
  // Split-A/B/C and Lane2 fan out and re-converge, so the main line takes one representative lane
  // through each. Catch is the high line over Penalty for marbles arriving fast; Penalty is the
  // through-line because it joins Merge's exit continuously (3 units) where Catch starts 8.5
  // units clear of it. The three Haz-* panels are PARALLEL lanes (pegs / paddle / gates at
  // z -139.8 / -148.0 / -156.2), not a sequence — LowerB's 24-wide mouth feeds all three at once.
  course1: {
    model: 'marble_track.glb',
    pathOut: 'track-path.js',
    collisionOut: 'track-collision.js',
    scale: 4,
    course: [
      { main: 'Track-Upper' },
      { main: 'Track-Split-A-direct', alt: ['Track-Split-A-detour'] },
      { main: 'Track-Mid' },
      { main: 'Track-Split-B-inner', alt: ['Track-Split-B-outer'] },
      { main: 'Track-Merge2' },
      { main: 'Track-Split-C-short', alt: ['Track-Split-C-long'] },
      { main: 'Track-Merge' },
      { main: 'Track-Penalty', alt: ['Track-Catch'] },
      { link: 'Track-Bowl' },
      { main: 'Track-LowerA' },
      { main: 'Track-Lane2-mid', alt: ['Track-Lane2-inner', 'Track-Lane2-outer'] },
      { main: 'Track-LowerB' },
      { main: 'Track-Haz-paddle', alt: ['Track-Haz-pegs', 'Track-Haz-gates'] },
      { main: 'Track-LowerC' },
    ],
    // LINKS bridge a stretch with no swept geometry to read a centerline from. Track-Bowl is a
    // funnel: rim at y 43.5 r 15.9 down to an open throat at y 32 r 2.5, centred on (-87.1,
    // -114). Marbles arrive over the rim from Penalty/Catch, spiral, and drop through the throat
    // onto Track-LowerA. Progress inside a funnel is genuinely ambiguous, so the main line takes
    // the honest straight shot: rim entry -> throat -> LowerA's mouth. halfWidth is the bowl
    // radius at that height, so the lateral gauge still reads sensibly while a marble circles.
    links: {
      'Track-Bowl': [
        { p: [-80.7, 43.5, -114.0], up: [0, 1, 0], halfWidth: 15.9 },
        { p: [-84.0, 37.0, -114.0], up: [0, 1, 0], halfWidth: 11.0 },
        { p: [-87.1, 33.0, -114.0], up: [0, 1, 0], halfWidth: 3.0 },
      ],
    },
  },

  // Grand Spiral (map 3), generated by scripts/build-marble-track-2.py — that script is the
  // source, not the GLB. Its course order, its two links (a funnel and a free fall) and its
  // material zones all come from a SIDECAR the generator writes alongside the model, because
  // every one of those is a fact about geometry the generator computed and this file would
  // otherwise have to restate in agreement with it. It would not stay in agreement.
  course2: {
    model: 'marble_track_2.glb',
    pathOut: 'track2-path.js',
    collisionOut: 'track2-collision.js',
    sidecar: 'marble_track_2.course.json',
    // wallGain is available (see WALL_GAIN) but deliberately left at the 2.6 default. Raising it
    // to 4.2 was tried and made things WORSE — 2 of 16 marbles finishing instead of 7. Taller
    // invisible walls between ADJACENT split lanes give the pack one more thing to wedge against
    // at a mouth, and this course's losses are marbles piling up, not marbles falling out.
  },
};

const COURSE_ID = process.argv[2] || 'course1';
const CFG = COURSES[COURSE_ID];
if (!CFG) {
  console.error(`unknown course "${COURSE_ID}" — expected one of: ${Object.keys(COURSES).join(', ')}`);
  process.exit(1);
}

// A sidecar supplies scale / course / links / zones / boost; anything set directly on the entry
// wins, so a course can be described inline (course1) or generated (course2) or a mix.
if (CFG.sidecar) {
  const sc = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', CFG.sidecar), 'utf8'));
  for (const k of ['scale', 'course', 'links', 'zones', 'boost', 'kickers']) {
    if (CFG[k] === undefined && sc[k] !== undefined) CFG[k] = sc[k];
  }
}

const GLB = path.join(ROOT, MODELS, CFG.model);
const OUT = path.join(ROOT, JS, CFG.pathOut);
const SCALE = CFG.scale;
const COURSE = CFG.course;
const LINKS = CFG.links || {};
// Zones re-map a stretch of a channel onto a different contact material. `rumble` (friction 0.3)
// and `bump` (restitution 0.12) are declared in physics.js and, before Grand Spiral, were used by
// nothing but the procedural chute. Ranges are fractions of the SEGMENT's own ring count, which
// is the only addressing that works for both a main line and an alt lane.
const ZONES = CFG.zones || [];
const BOOST = CFG.boost || [];
const KICKERS = CFG.kickers || [];

console.log(`course ${COURSE_ID}: ${CFG.model} -> ${CFG.pathOut} + ${CFG.collisionOut} (scale ${SCALE})\n`);

// ── glTF plumbing ───────────────────────────────────────────────────────────────────────────
const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546C67) throw new Error(`${file} is not a GLB`);
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4E4F534A) json = JSON.parse(chunk.toString('utf8'));
    else if (type === 0x004E4942) bin = chunk;
    off += 8 + len;
  }
  if (!json || !bin) throw new Error('GLB missing JSON or BIN chunk');
  return { json, bin };
}

function accessor(g, bin, idx) {
  const a = g.accessors[idx];
  const bv = g.bufferViews[a.bufferView];
  const T = COMP[a.componentType], n = NUM[a.type];
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const stride = bv.byteStride;
  if (!stride || stride === n * T.BYTES_PER_ELEMENT) return new T(bin.buffer, bin.byteOffset + base, a.count * n);
  const out = new T(a.count * n);
  for (let i = 0; i < a.count; i++) out.set(new T(bin.buffer, bin.byteOffset + base + i * stride, n), i * n);
  return out;
}

function nodeMatrix(n) {
  if (n.matrix) return n.matrix.slice();
  const t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

const xform = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

// ── vector helpers ──────────────────────────────────────────────────────────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const L = len(a) || 1; return [a[0] / L, a[1] / L, a[2] / L]; };
const mid = (a, b) => mul(add(a, b), 0.5);

// ── ring extraction ─────────────────────────────────────────────────────────────────────────
// Returns the ordered list of unique world-space positions for a node's single primitive.
function uniquePositions(g, bin, nodeIndex) {
  const node = g.nodes[nodeIndex];
  const m = nodeMatrix(node);
  const prims = g.meshes[node.mesh].primitives;
  if (prims.length !== 1) throw new Error(`${node.name}: expected 1 primitive, got ${prims.length}`);
  const raw = accessor(g, bin, prims[0].attributes.POSITION);
  const seen = new Set(), out = [];
  for (let i = 0; i < raw.length / 3; i++) {
    const p = xform(m, [raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]]);
    const k = `${p[0].toFixed(3)},${p[1].toFixed(3)},${p[2].toFixed(3)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

// Per-ring frame for a swept U-section channel. Throws if the mesh does not match the layout.
// `section` carries the four cross-section points a marble can actually touch, in order across
// the U: wall-top inner (one side) → floor → floor → wall-top inner (other side). That strip is
// what the collision shell is lofted from — see the collision notes further down.
function ringsOf(g, bin, nodeIndex, name) {
  const u = uniquePositions(g, bin, nodeIndex);
  if (u.length % 8 !== 0) throw new Error(`${name}: ${u.length} unique verts is not a multiple of 8 — the GLB was re-exported with a different vertex order, so the ring decoding in this baker no longer holds.`);
  const rings = [];
  for (let r = 0; r < u.length / 8; r++) {
    const v = u.slice(r * 8, r * 8 + 8);
    const floorL = v[4], floorR = v[5];
    const centre = mid(floorL, floorR);
    const width = len(sub(floorR, floorL));
    // Wall-top inner pair sits directly above the floor pair, so their midpoint difference is
    // the channel's up axis — this is what carries the banking through to the game.
    const up = norm(sub(mid(v[3], v[6]), centre));
    if (!(width > 0.5) || !Number.isFinite(up[0])) throw new Error(`${name}: ring ${r} decoded to width ${width} / up ${up} — layout assumption broken.`);
    rings.push({ p: centre, up, halfWidth: width / 2, section: [v[3], v[4], v[5], v[6]] });
  }
  // Smoothness assertion: a correctly ordered sweep advances by a small, consistent step. A
  // shuffled vertex buffer would show wild jumps here.
  let maxStep = 0;
  for (let r = 1; r < rings.length; r++) maxStep = Math.max(maxStep, len(sub(rings[r].p, rings[r - 1].p)));
  if (maxStep > 6) throw new Error(`${name}: max ring-to-ring step ${maxStep.toFixed(2)} — rings are not in sweep order.`);
  return rings;
}

// ── build ───────────────────────────────────────────────────────────────────────────────────
const { json: g, bin } = readGlb(GLB);
const byName = new Map();
g.nodes.forEach((n, i) => byName.set(n.name, i));

const need = (n) => {
  if (!byName.has(n)) throw new Error(`GLB has no node named ${n}`);
  return byName.get(n);
};

// Every swept U-section channel in the model — the main line's segments AND the branch lanes,
// which are just as collidable. Discovered rather than listed, so a re-exported model with an
// extra lane is picked up instead of silently missing its collider. Track-Bowl (a funnel) and
// Track-Bumper (a free-standing rim) are not swept channels and are excluded by ringsOf failing
// its layout assertion.
const CHANNEL_SEGMENTS = [];
let VISUAL_CHANNEL_TRIS = 0;
for (const [name, i] of byName) {
  if (!/^Track-/.test(name)) continue;
  try {
    ringsOf(g, bin, i, name);
  } catch {
    continue;   // not a swept channel — Bowl and Bumper land here by design
  }
  CHANNEL_SEGMENTS.push(name);
  for (const p of g.meshes[g.nodes[i].mesh].primitives) VISUAL_CHANNEL_TRIS += g.accessors[p.indices].count / 3;
}

// Main line: concatenate each main segment's rings in course order, dropping a leading ring when
// it duplicates the previous segment's tail (endpoints are exactly coincident by construction).
const samples = [];
const segRanges = [];
for (const step of COURSE) {
  const from = samples.length;
  if (step.link) {
    const link = LINKS[step.link];
    if (!link) throw new Error(`course step references link "${step.link}" but no such entry exists`);
    for (const s of link) samples.push({ ...s });
    segRanges.push({ name: step.link, role: 'main', from, to: samples.length - 1 });
    continue;
  }
  let rings = ringsOf(g, bin, need(step.main), step.main);
  // Orient the segment so it continues away from the previous tail rather than back into it.
  if (samples.length) {
    const tail = samples[samples.length - 1].p;
    if (len(sub(rings[rings.length - 1].p, tail)) < len(sub(rings[0].p, tail))) rings = rings.slice().reverse();
    if (len(sub(rings[0].p, tail)) < 0.25) rings = rings.slice(1);
  }
  for (const r of rings) samples.push(r);
  segRanges.push({ name: step.main, role: 'main', from, to: samples.length - 1 });
  for (const a of step.alt || []) segRanges.push({ name: a, role: 'alt', from, to: samples.length - 1 });
}

// Arclength + tangents. Tangent comes from neighbouring centres (central difference), then the
// up axis is re-orthogonalised against it so the {right, up, dir} basis handed to the game is
// exactly orthonormal even where the authored banking is slightly off-square.
const n = samples.length;
for (let i = 0; i < n; i++) {
  const a = samples[Math.max(0, i - 1)].p, b = samples[Math.min(n - 1, i + 1)].p;
  let dir = sub(b, a);
  if (len(dir) < 1e-6) dir = sub(samples[Math.min(n - 1, i + 1)].p, samples[Math.max(0, i - 1)].p);
  dir = norm(dir);
  const up0 = samples[i].up;
  const right = norm(cross(dir, up0));
  const up = norm(cross(right, dir));
  samples[i].dir = dir;
  samples[i].right = right;
  samples[i].up = up;
}
const cum = [0];
for (let i = 1; i < n; i++) cum.push(cum[i - 1] + len(sub(samples[i].p, samples[i - 1].p)));
const total = cum[n - 1];

// ── report ──────────────────────────────────────────────────────────────────────────────────
const f2 = (x) => x.toFixed(2);
console.log(`samples ${n}  arclength ${f2(total)} glb units (${f2(total * SCALE)} scaled)`);
console.log(`drop    ${f2(samples[0].p[1] - samples[n - 1].p[1])} glb units (${f2((samples[0].p[1] - samples[n - 1].p[1]) * SCALE)} scaled)`);
console.log(`start   ${samples[0].p.map(f2)}   finish ${samples[n - 1].p.map(f2)}`);
let gapMax = 0, gapAt = -1;
for (let i = 1; i < n; i++) { const d = len(sub(samples[i].p, samples[i - 1].p)); if (d > gapMax) { gapMax = d; gapAt = i; } }
console.log(`largest gap ${f2(gapMax)} at sample ${gapAt}`);
// Slope report. physics.js guarantees a marble can never be trapped by keeping the marble/
// surface friction coefficient BELOW tan(slope) everywhere, so gravity always wins. That
// guarantee is a property of the geometry, and this is where it can actually be checked: any
// segment whose slope falls under the tuned friction is a place the pack can stall.
const FRICTION = 0.09; // must match physics.js marble<->surface
console.log('\nsegment                  role  samples  s-range        halfWidth(scaled)  slope  min-slope');
for (const r of segRanges) {
  const seg = samples.slice(r.from, r.to + 1);
  const hw = seg.map((s) => s.halfWidth * SCALE);
  const run = cum[r.to] - cum[r.from];
  const slope = run > 0 ? (seg[0].p[1] - seg[seg.length - 1].p[1]) / run : 0;
  // Worst local slope over a 5-sample window — an averaged slope can hide a flat shelf.
  let worst = Infinity;
  for (let i = r.from; i + 5 <= r.to; i++) {
    const d = cum[i + 5] - cum[i];
    if (d > 1e-6) worst = Math.min(worst, (samples[i].p[1] - samples[i + 5].p[1]) / d);
  }
  const flag = Math.min(slope, Number.isFinite(worst) ? worst : slope) < FRICTION ? '  <-- below friction, can stall' : '';
  console.log(`${r.name.padEnd(24)} ${r.role.padEnd(5)} ${String(seg.length).padEnd(8)} ${f2(cum[r.from] / total)}..${f2(cum[r.to] / total)}   ${(f2(Math.min(...hw)) + '..' + f2(Math.max(...hw))).padEnd(18)} ${f2(slope).padStart(6)} ${(Number.isFinite(worst) ? f2(worst) : '  n/a').padStart(9)}${flag}`);
}

// ── collision shell ─────────────────────────────────────────────────────────────────────────
// The visual GLB is a closed 35,212-triangle solid. Colliding against it directly is what made
// the physics unaffordable: cannon-es runs seven sub-tests per triangle a query returns, once per
// marble per step, and a 101-marble field simply cannot pay that. So the collider is baked
// separately here, and it differs from the visual mesh in exactly two ways:
//
//   1. ONLY THE REACHABLE SURFACE. A marble can touch the floor top and the two wall inner
//      faces; it can never touch the floor underside, the wall exteriors or the wall caps, which
//      are sealed inside the solid. `section` (see ringsOf) is precisely that reachable strip,
//      so lofting it drops slightly over half the triangles with no change to any surface a
//      marble can reach.
//   2. DECIMATED ALONG THE SWEEP. Rings are ~1 GLB unit apart, far finer than a radius-0.25
//      (raw) marble needs. Keeping every COLLISION_STRIDE-th ring cuts the count again; the cost
//      is that curves become chords. Worst case is the start helix at radius ~14.5, where a
//      2-ring chord sags 14.5 - sqrt(14.5² - 1²) ≈ 0.035 units below the true surface — a
//      fortieth of the channel width, and well under the marble radius.
//
// The VISUAL mesh is untouched and still renders at full detail; only the collider is coarse.
const COLLISION_STRIDE = 2;

// ── splitter mouths ─────────────────────────────────────────────────────────────────────────
// The authored model does not have a divider nose at any of its splits. Where one channel feeds
// two or three parallel lanes, the lanes are simply narrower than the channel behind them, and
// the difference is an unsupported HOLE at the mouth. Measured at 4x scale: 10.0 world units at
// Upper->Split-A, 12.0 at Mid->Split-B, 10.0 at Merge2->Split-C, 9.0 at LowerA->Lane2, 6.0 at
// LowerB->the hazard fan — against a marble 2 units across. A 101-marble field pouring into that
// lost 53 marbles down the holes and then jammed solid on the lip of the first one.
//
// So the collision shell grows a nose the art does not have: each lane's entry rings are widened
// laterally until the lanes together span the channel feeding them, tapering back to the authored
// width over SPLIT_MOUTH_TAPER rings. Lanes may overlap slightly in the middle at the mouth,
// which is exactly what a splitter nose IS. This is COLLISION ONLY — the rendered model is
// untouched, so nothing about the look of the course changes.
const SPLIT_MOUTH_TAPER = 6;

// Collision-only wall height multiplier.
//
// The authored walls are 8.3 world units — about four marble diameters — and they are sized for
// the speed the banking implies: the start helix turns on a 56-unit radius at 24 degrees, whose
// design speed is sqrt(g*R*tan(bank)) = 42 u/s. Marbles actually arrive at roughly twice that,
// because the two uphill loops later in the course cannot be crested below ~56 u/s and the speed
// clamp has to leave room for it (see MAX_SPEED in marbles.js). At 85 u/s the centripetal demand
// on the helix is 129 u/s^2 against gravity's 72, so marbles ride high on the bank, and they were
// arriving at the Split-A mouth already outside the width the narrow split lanes begin at —
// roughly 70% of the field was lost there regardless of field size or speed cap.
//
// Raising the wall in the COLLISION shell only keeps them in. The visible rim is unchanged, so on
// the fastest turns a marble can ride a little above it; that is a far smaller price than most of
// the field disappearing, and it only shows where marbles are already pinned to the outside.
//
// PER COURSE, via `wallGain`. Grand Spiral needs more than Spiral Works' 2.6: it banks harder on
// wider channels and adds a near-vertical loop, an ice plate that stops marbles steering, and
// kickers that punch them sideways on purpose — every one of which drives the field UP the wall.
// It is collision-only, so raising it costs nothing visually.
const WALL_GAIN = CFG.wallGain ?? 2.6;

const floorMid = (ring) => mid(ring.section[1], ring.section[2]);

/**
 * Widen one lane's entry end so it reaches `growLo` / `growHi` further across, and — where that
 * growth met a NEIGHBOURING LANE — ramp the dividing wall up from nothing.
 *
 * That wall ramp is not cosmetic. Widening two lanes until they meet puts their inner walls
 * back to back, which turns the hole in the mouth into a full-height ridge (8.3 world units)
 * standing square across the arriving flow. Measured: marbles stopped dead against it and stayed
 * stopped even with the rest of the field deleted. A splitter nose has to START at floor level
 * and rise only as the lanes separate, which is what the taper below builds.
 */
function widenLaneEnd(e) {
  const n = e.rings.length;
  const meetA = e.loIsV4 ? e.meetLo : e.meetHi;   // does the v4 side face another lane?
  const meetB = e.loIsV4 ? e.meetHi : e.meetLo;   // does the v5 side?
  const growA = e.loIsV4 ? (e.growLo || 0) : (e.growHi || 0);
  const growB = e.loIsV4 ? (e.growHi || 0) : (e.growLo || 0);

  for (let k = 0; k < n; k++) {
    const ring = e.rings[e.atStart ? k : n - 1 - k];
    const t = k < SPLIT_MOUTH_TAPER ? 1 - k / SPLIT_MOUTH_TAPER : 0;

    // A side that grew to meet ANOTHER LANE keeps that growth for the lane's whole length. The
    // split lanes here run PARALLEL, so the divider gap between them is not a feature of the
    // mouth — it runs the entire way down. Tapering the growth back to the authored width simply
    // re-opened the hole a few rings in, and the field poured into it: 36 marbles lost at
    // Split-A alone. A side that grew to reach the outer WALL of the feeding channel does taper,
    // because that mismatch really is only at the handover and extending it would put collision
    // floor outside the visible track.
    const moveA = -(meetA ? growA : growA * t);
    const moveB = (meetB ? growB : growB * t);
    const ax = norm(sub(ring.section[2], ring.section[1]));   // v4 -> v5, across the channel
    ring.section[1] = add(ring.section[1], mul(ax, moveA));
    ring.section[0] = add(ring.section[0], mul(ax, moveA));
    ring.section[2] = add(ring.section[2], mul(ax, moveB));
    ring.section[3] = add(ring.section[3], mul(ax, moveB));

    // The dividing wall itself starts at floor level in the mouth (t = 1) and stands up to its
    // authored height by the end of the taper (t = 0). Two lanes widened until they touch put
    // their inner walls back to back, and at full height that is an 8.3-unit ridge square across
    // the arriving flow — marbles stopped dead against it and stayed stopped even with the rest
    // of the field deleted. Rising gradually, it does what a splitter nose does: sends a marble
    // one way or the other.
    if (meetA && t > 0) ring.section[0] = add(ring.section[1], mul(sub(ring.section[0], ring.section[1]), 1 - t));
    if (meetB && t > 0) ring.section[3] = add(ring.section[2], mul(sub(ring.section[3], ring.section[2]), 1 - t));
  }
}

/**
 * Close the hole where `fromRings` feeds `lanes`. Returns the width bridged, in GLB units.
 * The junction geometry makes this simple: every split in this model begins exactly where its
 * feeding channel ends (same centre point, same height), so the lanes differ from the channel
 * only ACROSS it, and closing the gap is a purely lateral widening with nothing to loft.
 */
function bridgeSplitMouth(fromRings, lanes) {
  const anchor = floorMid(lanes[0][0]);
  const exit = len(sub(floorMid(fromRings[0]), anchor)) < len(sub(floorMid(fromRings[fromRings.length - 1]), anchor))
    ? fromRings[0] : fromRings[fromRings.length - 1];

  const O = exit.section[1];
  const axis = norm(sub(exit.section[2], O));
  const W = len(sub(exit.section[2], O));

  const entries = lanes.map((rings) => {
    const first = rings[0], last = rings[rings.length - 1];
    const atStart = len(sub(floorMid(first), floorMid(exit))) <= len(sub(floorMid(last), floorMid(exit)));
    const ring = atStart ? first : last;
    const a = dot(sub(ring.section[1], O), axis);
    const b = dot(sub(ring.section[2], O), axis);
    return { rings, atStart, lo: Math.min(a, b), hi: Math.max(a, b), loIsV4: a <= b, growLo: 0, growHi: 0, meetLo: false, meetHi: false };
  }).sort((p, q) => p.lo - q.lo);

  // Walk the feeding channel's width and hand every uncovered piece to the lane edge beside it;
  // a gap BETWEEN two lanes is split evenly so the nose lands in the middle of it.
  let cursor = 0, bridged = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.lo > cursor) {
      const gap = e.lo - cursor;
      bridged += gap;
      // A gap at the very edge is the channel wall's own margin — the lane simply reaches out to
      // it. A gap BETWEEN lanes is the divider, split evenly, and both sides are flagged so the
      // wall between them ramps up instead of standing across the mouth.
      if (i === 0) e.growLo += gap;
      else {
        entries[i - 1].growHi += gap / 2; entries[i - 1].meetHi = true;
        e.growLo += gap / 2; e.meetLo = true;
      }
    }
    cursor = Math.max(cursor, e.hi);
  }
  if (cursor < W) { const e = entries[entries.length - 1]; e.growHi += W - cursor; bridged += W - cursor; }

  for (const e of entries) if (e.growLo || e.growHi) widenLaneEnd(e);
  return bridged;
}

// Collision rings are decoded fresh here, so widening a mouth cannot disturb the centerline bake
// above — that reads the authored geometry and must keep reading it.
const colRings = new Map();
for (const name of CHANNEL_SEGMENTS) colRings.set(name, ringsOf(g, bin, need(name), name));

console.log('\nsplitter mouths bridged (collision only):');
for (let i = 1; i < COURSE.length; i++) {
  const step = COURSE[i], prev = COURSE[i - 1];
  if (!step.alt || !step.alt.length || !prev.main) continue;
  const lanes = [step.main, ...step.alt].map((n) => colRings.get(n));
  if (!colRings.get(prev.main) || lanes.some((l) => !l)) continue;
  const bridged = bridgeSplitMouth(colRings.get(prev.main), lanes);
  console.log(`  ${prev.main} -> ${[step.main, ...step.alt].map((n) => n.replace('Track-', '')).join(' + ')}: ${f2(bridged * SCALE)} world units`);
}

const colVerts = [];
// One index array per contact material. `surface` is the default and stays exported as INDICES so
// a course with no zones emits exactly what it always did.
const colByMaterial = { surface: [], rumble: [], bump: [], ice: [] };
const colSegments = [];

/** Contact material for ring `r` of `name`, given the segment's total ring count. */
function materialForRing(name, r, ringCount) {
  const t = ringCount > 1 ? r / (ringCount - 1) : 0;
  for (const z of ZONES) {
    if (!z.segments.includes(name)) continue;
    if (t >= z.from && t <= z.to) return z.material;
  }
  return 'surface';
}

for (const name of CHANNEL_SEGMENTS) {
  const rings = colRings.get(name);
  // Always keep the last ring, so a segment never ends short of where its geometry does and
  // leaves a gap at the join with the next one.
  const kept = [];
  for (let r = 0; r < rings.length; r += COLLISION_STRIDE) kept.push(rings[r]);
  if (kept[kept.length - 1] !== rings[rings.length - 1]) kept.push(rings[rings.length - 1]);

  const firstTri = colByMaterial.surface.length / 3;
  const base = colVerts.length / 3;
  // Ring index within the ORIGINAL sweep for each kept ring, so a zone expressed as a fraction of
  // the segment still lands in the right place after decimation.
  const keptRingIdx = [];
  for (let r = 0; r < rings.length; r += COLLISION_STRIDE) keptRingIdx.push(r);
  if (keptRingIdx[keptRingIdx.length - 1] !== rings.length - 1) keptRingIdx.push(rings.length - 1);
  for (const ring of kept) {
    // section = [wall-top, floor, floor, wall-top] across the U. Push the two wall tops further
    // from the floor edge they sit above; the floor itself is untouched.
    const s0 = add(ring.section[1], mul(sub(ring.section[0], ring.section[1]), WALL_GAIN));
    const s3 = add(ring.section[2], mul(sub(ring.section[3], ring.section[2]), WALL_GAIN));
    for (const p of [s0, ring.section[1], ring.section[2], s3]) colVerts.push(p[0], p[1], p[2]);
  }

  // Decide the winding ONCE per segment, from the floor quad of the first pair: the floor's
  // geometric normal must point along the ring's up axis, i.e. into the channel. Ring order and
  // section order are both consistent within a segment, so that single choice orients the wall
  // quads correctly too.
  let flip = false;
  {
    const a = kept[0].section[1], b = kept[0].section[2], c = kept[1].section[2];
    const n = cross(sub(b, a), sub(c, a));
    flip = dot(n, kept[0].up) < 0;
  }

  for (let i = 0; i + 1 < kept.length; i++) {
    // The quad strip between two rings takes the material of the earlier one.
    const out = colByMaterial[materialForRing(name, keptRingIdx[i], rings.length)] || colByMaterial.surface;
    for (let k = 0; k < 3; k++) {          // 3 quads across the U: wall, floor, wall
      const p00 = base + i * 4 + k, p01 = base + i * 4 + k + 1;
      const p10 = base + (i + 1) * 4 + k, p11 = base + (i + 1) * 4 + k + 1;
      if (flip) out.push(p00, p10, p11, p00, p11, p01);
      else out.push(p00, p11, p10, p00, p01, p11);
    }
  }
  colSegments.push({ name, tris: colByMaterial.surface.length / 3 - firstTri, rings: rings.length, kept: kept.length });
}

const colTris = Object.values(colByMaterial).reduce((n, a) => n + a.length / 3, 0);
for (const [m, arr] of Object.entries(colByMaterial)) {
  if (m !== 'surface' && arr.length) console.log(`  zone ${m}: ${arr.length / 3} triangles`);
}
console.log(`\ncollision shell: ${colTris} triangles from ${colVerts.length / 3} vertices (stride ${COLLISION_STRIDE})`);
console.log(`  vs ${VISUAL_CHANNEL_TRIS} visual triangles across the same ${CHANNEL_SEGMENTS.length} channels — ${(VISUAL_CHANNEL_TRIS / colTris).toFixed(1)}x fewer`);

// ── boost bands ─────────────────────────────────────────────────────────────────────────────
// Declared as a fraction of a named segment, resolved here into absolute arclength. Addressing
// them by segment rather than by a global fraction means a band stays where it was authored even
// after a section either side of it changes length.
const boostBands = [];
for (const b of BOOST) {
  for (const segName of b.segments) {
    const r = segRanges.find((x) => x.name === segName);
    if (!r) throw new Error(`boost band references unknown segment "${segName}"`);
    const a = cum[r.from], z = cum[r.to];
    boostBands.push([a + (z - a) * b.from, a + (z - a) * b.to]);
  }
}
if (boostBands.length) {
  console.log(`\nboost bands: ${boostBands.map(([a, z]) => `${f2(a * SCALE)}..${f2(z * SCALE)}`).join(', ')} world units`);
}

// Kicker bands, emitted as NORMALIZED fractions of the course rather than arclength. That is not
// an inconsistency with the boost bands above — game.js's _fireKicker tests `m.s / track.length`
// while _applyBoost tests `m.s` directly, so each is baked in the unit its consumer already uses.
const kickerBands = [];
for (const k of KICKERS) {
  for (const segName of k.segments) {
    const r = segRanges.find((x) => x.name === segName);
    if (!r) throw new Error(`kicker band references unknown segment "${segName}"`);
    const a = cum[r.from], z = cum[r.to];
    kickerBands.push([(a + (z - a) * k.from) / total, (a + (z - a) * k.to) / total]);
  }
}
if (kickerBands.length) {
  console.log(`kicker bands: ${kickerBands.map(([a, z]) => `${f2(a * 100)}%..${f2(z * 100)}%`).join(', ')}`);
}

// ── emit ────────────────────────────────────────────────────────────────────────────────────
const num = (x) => {
  const v = Math.round(x * 1000) / 1000;
  return Object.is(v, -0) ? '0' : String(v);
};
const flat = (key) => samples.map((s) => s[key].map(num).join(',')).join(', ');

const out = `// ${CFG.pathOut} — GENERATED by scripts/bake-marble-track.mjs ${COURSE_ID}. Do not hand-edit.
//
// Baked centerline for wwwroot/models/${CFG.model}. The authored course descends in -Y along
// a winding XZ path and branches, so the game cannot use "progress = z" the way the old
// procedural chute did. This is the single monotonic line every progress-keyed system now
// projects onto: standings, camera framing, finish detection, out-of-bounds culling, the boost
// basis and the HUD edge gauge.
//
// Values are in RAW GLB units. track.js multiplies positions and widths by SCALE; the dir/up/
// right bases are unit vectors and scale-invariant.
//
// Branch lanes (Split-A/B/C, Lane2, the Haz fan, Catch) are NOT on this line — they collide and
// render normally, and a marble riding one is measured by projecting onto the representative
// lane. See COURSE in the baker for which lane each branch resolves to.

export const SCALE = ${SCALE};

/** Number of samples on the centerline. */
export const COUNT = ${n};

/** Total centerline arclength, raw GLB units. Multiply by SCALE for world units. */
export const ARCLENGTH = ${num(total)};

/** Floor-centre positions, xyz triples. */
export const POINTS = Float32Array.from([${flat('p')}]);

/** Unit forward tangents, xyz triples. */
export const DIRS = Float32Array.from([${flat('dir')}]);

/** Unit up axes (carries the authored banking), xyz triples. */
export const UPS = Float32Array.from([${flat('up')}]);

/** Unit lateral axes, = dir x up, xyz triples. */
export const RIGHTS = Float32Array.from([${flat('right')}]);

/** Half channel width at each sample, raw GLB units. */
export const HALF_WIDTHS = Float32Array.from([${samples.map((s) => num(s.halfWidth)).join(', ')}]);

/** Cumulative arclength at each sample, raw GLB units. Monotonic, CUM[0] = 0. */
export const CUM = Float32Array.from([${cum.map(num).join(', ')}]);

/**
 * Boost pads as [startS, endS] pairs in RAW arclength — track-glb.js scales them and exposes
 * inBoost(s). These have NO collider: game.js reads the predicate each frame and accelerates
 * whatever is on top, so a pad is a range plus a Deco ribbon, not a shape.
 */
export const BOOST_BANDS = ${JSON.stringify(boostBands.map((b) => b.map((v) => Number(num(v)))))};

/**
 * Kicker bands as [startFrac, endFrac] of the whole course, 0..1 — the unit game.js's
 * _fireKicker compares against. Each pairs with the Deco-Kicker-N mesh of the same index.
 */
export const KICKER_BANDS = ${JSON.stringify(kickerBands.map((b) => b.map((v) => Math.round(v * 1e5) / 1e5)))};

/**
 * Which authored segment covers which stretch of the line. \`alt\` entries share their \`from\`/\`to\`
 * with the main lane they parallel — they are branch lanes, not extra distance.
 */
export const SEGMENTS = ${JSON.stringify(segRanges, null, 2).replace(/\n/g, '\n')};
`;

fs.writeFileSync(OUT, out);
console.log(`\nwrote ${path.relative(ROOT, OUT)} (${(out.length / 1024).toFixed(1)} KB)`);

const colOut = `// ${CFG.collisionOut} — GENERATED by scripts/bake-marble-track.mjs ${COURSE_ID}. Do not hand-edit.
//
// Low-poly collision shell for the swept channels of wwwroot/models/${CFG.model}. This is
// NOT the mesh you see: the visual model still renders at its full ${VISUAL_CHANNEL_TRIS} channel triangles.
// This is only what the marbles collide against, and it differs deliberately in two ways:
//
//   * it contains ONLY the reachable surface — floor top plus the two wall inner faces. The
//     floor underside, wall exteriors and wall caps are sealed inside the solid and cannot take
//     a contact, so carrying them cost narrowphase time for nothing.
//   * it is decimated to every ${COLLISION_STRIDE}${COLLISION_STRIDE === 2 ? 'nd' : 'rd'} ring along the sweep, which turns curves into chords.
//     Worst-case sag is on the start helix at radius ~14.5 raw units: about 0.035 units, far
//     under the 0.25 raw marble radius.
//
// Why it exists: cannon-es runs seven sub-tests per triangle returned by a query, once per
// marble per step. Against the full visual solid a 101-marble field cost ~31 ms per physics
// step; the budget is ~8 ms. See track.js for the rest of that story.
//
// Values are RAW GLB units — track.js multiplies by SCALE from track-path.js.

/** Vertex positions, xyz triples. */
export const VERTICES = Float32Array.from([${colVerts.map(num).join(',')}]);

/** Triangle indices into VERTICES for the default 'surface' contact material. */
export const INDICES = Uint32Array.from([${colByMaterial.surface.join(',')}]);

/**
 * Zoned triangles — the same vertex buffer, split out so track-glb.js can give them a different
 * contact material. Empty on a course that declares no zones.
 *   RUMBLE: friction 0.3, a floor that scrubs speed without ever being able to stop a marble
 *           (the coefficient is held under the local tan(slope) — see physics.js).
 *   BUMP:   restitution 0.12, the washboard ridges, low-bounce so they jostle without launching.
 *   ICE:    friction 0.02 — far under the (2/7)*tan(slope) needed to roll, so marbles skid: they
 *           keep their speed but lose the grip to hold a line into the next turn.
 */
export const RUMBLE_INDICES = Uint32Array.from([${colByMaterial.rumble.join(',')}]);
export const BUMP_INDICES = Uint32Array.from([${colByMaterial.bump.join(',')}]);
export const ICE_INDICES = Uint32Array.from([${colByMaterial.ice.join(',')}]);

/** Per-segment triangle counts, for diagnostics. */
export const SEGMENTS = ${JSON.stringify(colSegments)};
`;
const COL_OUT = path.join(ROOT, JS, CFG.collisionOut);
fs.writeFileSync(COL_OUT, colOut);
console.log(`wrote ${path.relative(ROOT, COL_OUT)} (${(colOut.length / 1024).toFixed(1)} KB)`);
