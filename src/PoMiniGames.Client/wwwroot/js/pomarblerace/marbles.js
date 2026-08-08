// marbles.js — a 101-marble field (1 red player marble + 100 AI rivals), progress + finish
// tracking.
//
// The field is one RED marble the player steers against a pack of 100 rivals, each with its own
// colour (PACK_PALETTE) and its own procedural glass pattern (the atlas below). Every marble is
// physically identical (same radius/mass/damping), so a race is decided purely by steering skill
// and the scramble of the pack — there's no per-marble build to pick. The pack shares one
// geometry and one material and carries no trails/blobs/shadows; only the red player marble gets
// the full treatment (own material, motion trail, contact blob, collision sparks).
//
// GFX #1 — INSTANCING. Sharing a geometry and a material still cost 100 separate draw calls and
// 100 scene-graph nodes walked per frame, because they were 100 separate Mesh objects. The pack
// is now ONE InstancedMesh: 100 draw calls collapse to 1. Each pack marble keeps a bare
// Object3D as its `.mesh` — never added to the scene, but carrying the same position/quaternion/
// visible fields the rest of the engine already reads (game.js fires sparks at m.mesh.position
// in four places), so instancing is invisible to every existing call site. sync() composes those
// proxies into the instance matrix buffer.
//
// Per-marble variety survives that collapse: `instanceColor` carries each marble's palette
// colour and a per-instance UV offset picks its cell out of the shared texture atlas, so 100
// visually distinct marbles still cost exactly one draw call.
//
// The headroom this frees is what pays for the motion blur, shockwave rings and road sheen added
// alongside it — see docs/superpowers/specs/2026-07-28-pomarblerace-gfx-audio-design.md.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { TRACK } from './track.js';

export const MARBLE_COUNT = 101;    // 1 red player + 100 AI rivals
export const PLAYER_INDEX = 0;      // index 0 is the red marble the player controls

const RED = 0xef4444;   // the player — see PACK_PALETTE for why nothing else may be red

// ── Pack palette ──
// The pack used to be 100 identical blue marbles. It is now a spread of distinct colours, each
// carrying one of the procedural glass-marble patterns in the atlas below.
//
// NOTHING IN HERE IS RED, AND THAT IS LOAD-BEARING. The player's entire identification mechanic
// is "you are the ONE red marble" — the intro card says it, the start overlay says it, and the
// camera locks to that marble for the whole race. A crimson or tomato entry in this palette
// would put a decoy in the pack. Oranges are the closest this gets, and they are the light,
// clearly-amber end (#fb923c / #fdba74) rather than anything that reads scarlet at speed.
//
// MIRRORED IN C#: PoMarbleRacePage.razor ColorOf() reproduces this array exactly, because the
// HUD's podium dots and edge-gauge marker have to match the marble you are looking at. Colour is
// a pure function of the marble index — the index is the contract between the two files. Change
// this array and you MUST change that one.
const PACK_PALETTE = [
  0xf59e0b, 0xfacc15, 0xa3e635, 0x22c55e, 0x10b981, 0x14b8a6, 0x22d3ee, 0x38bdf8,
  0x3b82f6, 0x6366f1, 0x8b5cf6, 0xa855f7, 0xd946ef, 0xec4899, 0xfb923c, 0x84cc16,
  0xfcd34d, 0xbef264, 0x4ade80, 0x34d399, 0x2dd4bf, 0x67e8f9, 0x7dd3fc, 0x93c5fd,
  0xa5b4fc, 0xc4b5fd, 0xd8b4fe, 0xf0abfc, 0xf9a8d4, 0xfdba74, 0xfde68a, 0x5eead4,
];

// Colour for a marble index. Index 0 is the player and is always red; everything else cycles the
// palette. Deterministic, so JS and C# agree without any colour crossing the interop boundary.
export function marbleColor(index) {
  return index === PLAYER_INDEX ? RED : PACK_PALETTE[(index - 1) % PACK_PALETTE.length];
}

// Kept as an array so the rest of the engine can still look a marble up by index. Physically
// uniform — index 0 is red, every other index takes its colour from PACK_PALETTE.
//
// Real glass marble: at the world scale of 1 unit = 1 cm, a radius-1 marble is 20 mm across,
// and solid soda-lime glass (~2500 kg/m³) makes that ≈ 10.5 g. Mass is carried here as 1.0
// "marble unit" (the obstacle masses in track.js are multiples of it), and cannon-es derives a
// real SOLID-SPHERE moment of inertia (I = 2/5·m·r²) from the sphere shape — so the marbles
// carry realistic rotational momentum and roll true. Damping is near zero: real glass has
// negligible rolling resistance and air drag at this size, so a marble keeps its spin.
export const MARBLE_ROSTER = Array.from({ length: MARBLE_COUNT }, (_, i) => ({
  name: i === PLAYER_INDEX ? 'You' : 'Marble',
  color: marbleColor(i),
  radius: 1.0, mass: 1.0, linDamp: 0.003, angDamp: 0.002,
}));

export const MARBLE_COLORS = MARBLE_ROSTER.map((m) => m.color);

const TRAIL_LEN = 16;

// ── Marker chrome: deliberately none ──
// There used to be a white highlight ring around the player's marble and two billboarded pins
// above it ('YOU' and '◉ ON AIR'). All three are gone. They existed to answer "which marble is
// mine?" back when the field was eight differently-coloured marbles that the camera could cut
// away from. Neither condition holds now: the player is the ONE red marble — no other marble in
// the field may be red (see PACK_PALETTE) — and the camera stays locked to it for the whole race
// (game.js _pickShot), so the marble you steer is the red one in the middle of the screen. The
// ring and pins were just occluding it.
//
// Note this is exactly why the pack getting individual colours did NOT reintroduce the old
// problem: the field is varied, but red is still reserved, and the camera still never leaves you.

// ── Glass-marble texture atlas ──────────────────────────────────────────
// 16 procedural marble patterns packed 4×4 into one canvas, so the whole pack still renders in a
// SINGLE draw call: each instance samples its own cell via a per-instance UV offset (see the
// onBeforeCompile patch in createMarbles).
//
// The patterns are drawn in GREYSCALE on a near-white base, because instanceColor MULTIPLIES the
// sampled texel. White base × instance colour = that marble's pure colour; the darker swirls
// become deeper shades of it and the near-white glints stay as highlights. Painting the patterns
// in actual colours here would multiply twice and mud everything toward black.
//
// Sphere UVs are equirectangular, so a horizontal band in a cell wraps as a RING around the
// marble (the classic cat's-eye ribbon) and a vertical stripe becomes a meridian. The patterns
// below are deliberately low-frequency: mip levels blend across cell boundaries in an atlas, and
// broad shapes make that bleed invisible at the size a pack marble actually occupies on screen.
const ATLAS_COLS = 4, ATLAS_ROWS = 4;
const ATLAS_CELLS = ATLAS_COLS * ATLAS_ROWS;
const ATLAS_CELL = 256;                       // px per cell → 1024×1024 sheet

let _atlasTex = null;
function marbleAtlas() {
  if (_atlasTex) return _atlasTex;
  const c = document.createElement('canvas');
  c.width = ATLAS_COLS * ATLAS_CELL;
  c.height = ATLAS_ROWS * ATLAS_CELL;
  const g = c.getContext('2d');
  const S = ATLAS_CELL;

  // Deterministic per-cell RNG so the atlas is identical on every load — a marble that changes
  // pattern between races would read as a different marble.
  const rngFor = (seed) => {
    let s = (seed * 1664525 + 1013904223) >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  };

  for (let cell = 0; cell < ATLAS_CELLS; cell++) {
    const ox = (cell % ATLAS_COLS) * S;
    const oy = ((cell / ATLAS_COLS) | 0) * S;
    const rnd = rngFor(cell + 1);

    g.save();
    g.beginPath();
    g.rect(ox, oy, S, S);
    g.clip();

    // Base: bright, faintly graded glass body.
    const base = g.createLinearGradient(ox, oy, ox, oy + S);
    base.addColorStop(0, '#ffffff');
    base.addColorStop(0.5, '#e8ecf2');
    base.addColorStop(1, '#cdd5e0');
    g.fillStyle = base;
    g.fillRect(ox, oy, S, S);

    const kind = cell % 4;
    if (kind === 0) {
      // CAT'S EYE — a wide wavy ribbon across the equator, the classic glass marble.
      const mid = S * (0.42 + rnd() * 0.16);
      const amp = S * (0.05 + rnd() * 0.07);
      const thick = S * (0.16 + rnd() * 0.12);
      for (const [inset, shade] of [[0, 'rgba(70,84,104,0.85)'], [thick * 0.3, 'rgba(150,164,186,0.8)']]) {
        g.beginPath();
        for (let x = 0; x <= S; x += 4) {
          const y = mid + Math.sin((x / S) * Math.PI * 2 + cell) * amp;
          if (x === 0) g.moveTo(ox + x, oy + y - thick / 2 + inset); else g.lineTo(ox + x, oy + y - thick / 2 + inset);
        }
        for (let x = S; x >= 0; x -= 4) {
          const y = mid + Math.sin((x / S) * Math.PI * 2 + cell) * amp;
          g.lineTo(ox + x, oy + y + thick / 2 - inset);
        }
        g.closePath();
        g.fillStyle = shade;
        g.fill();
      }
    } else if (kind === 1) {
      // SWIRL — diagonal ribbons sweeping around the sphere.
      const bands = 3 + ((rnd() * 3) | 0);
      for (let b = 0; b < bands; b++) {
        g.beginPath();
        const phase = rnd() * Math.PI * 2;
        const w = S * (0.05 + rnd() * 0.09);
        for (let x = 0; x <= S; x += 4) {
          const y = S * 0.5 + Math.sin((x / S) * Math.PI * 3 + phase) * S * 0.3 + (b - bands / 2) * S * 0.16;
          if (x === 0) g.moveTo(ox + x, oy + y); else g.lineTo(ox + x, oy + y);
        }
        g.strokeStyle = b % 2 === 0 ? 'rgba(64,78,98,0.75)' : 'rgba(158,172,192,0.7)';
        g.lineWidth = w;
        g.lineCap = 'round';
        g.stroke();
      }
    } else if (kind === 2) {
      // SPECKLE — aggregate/granite glass, lots of small inclusions.
      for (let k = 0; k < 900; k++) {
        const x = rnd() * S, y = rnd() * S, r = rnd() * 5 + 1;
        const v = rnd();
        g.fillStyle = v < 0.45 ? 'rgba(72,86,108,0.55)'
          : (v < 0.8 ? 'rgba(168,180,198,0.5)' : 'rgba(255,255,255,0.75)');
        g.beginPath(); g.arc(ox + x, oy + y, r, 0, 6.283); g.fill();
      }
    } else {
      // BANDED — broad latitude stripes, reading as rings around the marble.
      const bands = 3 + ((rnd() * 3) | 0);
      for (let b = 0; b < bands; b++) {
        const y = (b / bands) * S + rnd() * 8;
        const h = S / bands * (0.35 + rnd() * 0.4);
        g.fillStyle = b % 2 === 0 ? 'rgba(76,90,112,0.6)' : 'rgba(176,188,206,0.55)';
        g.fillRect(ox, oy + y, S, h);
      }
    }

    // Shared glass finish: a bright specular bloom up top and a soft occlusion at the bottom, so
    // every pattern reads as a rounded glass ball rather than a flat decal.
    const glint = g.createRadialGradient(ox + S * 0.32, oy + S * 0.26, 2, ox + S * 0.32, oy + S * 0.26, S * 0.34);
    glint.addColorStop(0, 'rgba(255,255,255,0.95)');
    glint.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = glint;
    g.fillRect(ox, oy, S, S);

    const shade = g.createLinearGradient(ox, oy + S * 0.6, ox, oy + S);
    shade.addColorStop(0, 'rgba(30,40,58,0)');
    shade.addColorStop(1, 'rgba(30,40,58,0.45)');
    g.fillStyle = shade;
    g.fillRect(ox, oy, S, S);

    g.restore();
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  // ClampToEdge, not Repeat: each instance samples a sub-rect, and wrapping would let a marble
  // at a cell edge pull in its neighbour's pattern.
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  _atlasTex = t;
  return t;
}

// Which atlas cell a marble uses. Multiplied by a prime so the pattern cycle does NOT line up
// with the 32-entry colour cycle — otherwise every marble sharing a colour would also share a
// pattern, and the pack would visibly repeat every 32 marbles.
function atlasCell(index) {
  return (index * 7) % ATLAS_CELLS;
}

// Soft radial-gradient disc used as a fake contact shadow under each marble (#8). Built once.
let _blobTex = null;
function blobTexture() {
  if (_blobTex) return _blobTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  _blobTex = new THREE.CanvasTexture(c);
  return _blobTex;
}

/**
 * @param {THREE.Texture} [envMap] PMREM-prefiltered environment, applied to the marble materials
 *   ONLY (realism pass #3). The scene has no global environment — see scene.js — so this is what
 *   gives the spheres a specular highlight without putting reflections on the track.
 */
export function createMarbles(world, materials, startPositions, chosenIndex, onCollide, envMap) {
  const marbles = [];
  let finishCounter = 0;

  // Trails (#6) and contact blobs (#8) live in world space, so they sit in a sibling group
  // rather than under the (spinning) marble meshes.
  const decorations = new THREE.Group();
  const blobTex = blobTexture();

  // Everything the marble set draws lives under one group, so game.js adds and removes a single
  // node per race instead of looping over 101 meshes. Contents: the player's Mesh + the pack's
  // InstancedMesh.
  const group = new THREE.Group();

  // The 100 pack marbles SHARE one geometry + one material, which is what keeps them cheap to
  // draw; their individuality comes from per-instance colour and per-instance atlas cell rather
  // than from separate materials. The red player marble owns its own geometry/material (and is
  // the only marble with a trail, blob and collision sparks). Low-poly sphere: 100 of them, so
  // the segment count matters.
  // 2026-08-08 realism pass #2: 12×8 → 20×14. The note this replaces argued 12×8 was "invisible
  // at the size these render", which held for the old pack-overview camera. The camera is a chase
  // cam now (scene.js CAM_BACK) and marbles regularly fill a good part of the frame, where an
  // 8-band sphere reads as a faceted lump rather than a ball — the silhouette gives it away even
  // when the shading does not. 168 → 504 triangles each; at 100 instances in ONE draw call that
  // is still a rounding error next to the track ribbon, and it buys a round silhouette in exactly
  // the shots the player is looking at.
  const packGeo = new THREE.SphereGeometry(1.0, 20, 14);
  const atlas = marbleAtlas();
  // Realism pass #3: roughness pulled in and a scoped env map attached. Glass reads as glass
  // because of one tight highlight and a hint of what is around it; with no environment at all
  // (scene.environment was removed) a 0.34-rough sphere lit by three lights is indistinguishable
  // from matte putty. `envMapIntensity` is kept low — this is a sheen, not a chrome ball.
  const packMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0x000000, emissiveIntensity: 0, roughness: 0.18, metalness: 0.0,
    map: atlas,
    envMap: envMap || null,
    envMapIntensity: envMap ? 0.85 : 0,
  });
  // NOTE the white base colour above: with an InstancedMesh, `instanceColor` MULTIPLIES both the
  // material colour and the sampled texel. White here means a marble's rendered colour is exactly
  // its palette entry times the greyscale swirl pattern — any tint on the material itself would
  // be applied a second time on top of every marble's own colour.
  const PACK_COUNT = MARBLE_COUNT - 1;   // every marble except the player
  const pack = new THREE.InstancedMesh(packGeo, packMat, PACK_COUNT);
  // The pack spans the whole track and is a single draw call, so per-object frustum culling has
  // nothing to win and would only risk popping the whole field out at once.
  pack.frustumCulled = false;
  // 2026-08-08 realism pass #1: the pack cast NO shadow at all — only the player's marble did —
  // so 100 of the 101 marbles floated over the road with nothing tying them to it. Contact
  // shadow is the single strongest cue that an object is resting on a surface, and its absence
  // is most of why the pack read as sprites laid over the track. An InstancedMesh casts for
  // every instance from one shadow draw, so this is one extra pass over the pack, not a hundred.
  pack.castShadow = true;
  // Receive too: marbles in a pile-up should darken the ones beneath them.
  pack.receiveShadow = true;
  pack.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Per-instance colour — impossible while the pack shared one material. Each marble carries its
  // own palette colour for the whole race.
  //
  // This REPLACES the speed-reactive blue→cyan tint that lived here: with every marble now a
  // different colour, a tint that drove them all toward the same cyan at pace would have undone
  // exactly the variety it is supposed to show. Written once at construction, not per frame.
  pack.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(PACK_COUNT * 3), 3);
  group.add(pack);

  // Per-instance atlas cell. This is what lets 100 marbles show 16 different glass patterns from
  // ONE draw call: each instance gets the UV origin of its cell, and the vertex patch below
  // scales the sphere's UVs into that cell.
  const uvOffsets = new Float32Array(PACK_COUNT * 2);
  packGeo.setAttribute('aUvOffset', new THREE.InstancedBufferAttribute(uvOffsets, 2));

  // Inject the atlas lookup into three's standard material. `vMapUv` is produced by the
  // <uv_vertex> chunk whenever a map is present, so remapping it right after that chunk reroutes
  // every texture read for this instance into its own cell — no fragment-shader surgery, and the
  // rest of MeshStandardMaterial (lighting, IBL, shadows) is untouched.
  const cellU = 1 / ATLAS_COLS, cellV = 1 / ATLAS_ROWS;
  packMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aUvOffset;')
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>\n\tvMapUv = vMapUv * vec2(${cellU.toFixed(6)}, ${cellV.toFixed(6)}) + aUvOffset;`);
  };

  // Scratch objects for composing instance matrices — allocated once, reused every frame for
  // every marble. sync() runs 100 times a frame; allocating here would be 6000 objects/second.
  const _m4 = new THREE.Matrix4();
  const _scale = new THREE.Vector3(1, 1, 1);
  const _zero = new THREE.Vector3(0, 0, 0);
  const _col = new THREE.Color();

  for (let i = 0; i < MARBLE_COUNT; i++) {
    const spec = MARBLE_ROSTER[i];
    const isPlayer = i === PLAYER_INDEX;
    const radius = spec.radius;

    // The player is a real Mesh (it alone casts/receives shadows and owns its material). Every
    // other marble is drawn as an instance of `pack`, so its `.mesh` is a bare Object3D proxy:
    // never added to the scene, but carrying the position/quaternion/visible fields the rest of
    // the engine reads. sync() composes the proxy's transform into the instance buffer.
    let sphereGeo = null, mat = null, mesh;
    const packIndex = isPlayer ? -1 : i - 1;   // instance slot; player has none
    if (isPlayer) {
      sphereGeo = new THREE.SphereGeometry(radius, 24, 18);
      // The player gets the same glass treatment as the pack, but through a CLONED texture with
      // its own offset/repeat rather than the instanced UV patch (it's a plain Mesh, not an
      // instance). Texture.clone() shares the underlying source, so this is a transform on the
      // same GPU upload, not a second copy of the atlas.
      //
      // It stays unmistakably RED and gets the emissive lift no pack marble has: this is the
      // marble you steer and the camera is locked to, and the whole game tells you to look for
      // the red one. Nothing in PACK_PALETTE is allowed near this hue.
      const playerTex = atlas.clone();
      playerTex.needsUpdate = true;
      playerTex.repeat.set(1 / ATLAS_COLS, 1 / ATLAS_ROWS);
      const pc = atlasCell(PLAYER_INDEX + 3);   // a cat's-eye cell — the most "marble" of the four
      playerTex.offset.set((pc % ATLAS_COLS) / ATLAS_COLS, ((pc / ATLAS_COLS) | 0) / ATLAS_ROWS);
      mat = new THREE.MeshStandardMaterial({
        // Same treatment as the pack (realism pass #3), a touch glossier still: this is the one
        // marble the camera is locked to, so it carries the closest look.
        color: RED, emissive: 0x3b0a0a, emissiveIntensity: 0.25, roughness: 0.14, metalness: 0.0,
        envMap: envMap || null,
        envMapIntensity: envMap ? 0.95 : 0,
        map: playerTex,
      });
      mesh = new THREE.Mesh(sphereGeo, mat);
      // Only the player casts/receives shadows — 100 shadow-casters would swamp the shadow map.
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    } else {
      mesh = new THREE.Object3D();
      // The proxy is driven manually and never rendered, so skip the auto matrix work three.js
      // would otherwise do for it.
      mesh.matrixAutoUpdate = false;
    }
    mesh.position.copy(startPositions[i]);

    // Trail + contact blob are the player's alone (a trail per pack marble would be 100 extra
    // draw calls for marbles you're not watching).
    let trail = null, trailPos = null, blob = null, blobGeo = null;
    if (isPlayer) {
      trailPos = new Float32Array(TRAIL_LEN * 3);
      const trailCol = new Float32Array(TRAIL_LEN * 3);
      const baseCol = new THREE.Color(RED);
      for (let j = 0; j < TRAIL_LEN; j++) {
        trailPos[j * 3] = startPositions[i].x;
        trailPos[j * 3 + 1] = startPositions[i].y;
        trailPos[j * 3 + 2] = startPositions[i].z;
        const f = 1 - j / TRAIL_LEN;
        trailCol[j * 3] = baseCol.r * f; trailCol[j * 3 + 1] = baseCol.g * f; trailCol[j * 3 + 2] = baseCol.b * f;
      }
      const trailGeo = new THREE.BufferGeometry();
      trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
      trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
      const trailMat = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      trail = new THREE.Line(trailGeo, trailMat);
      trail.frustumCulled = false;
      decorations.add(trail);

      blobGeo = new THREE.CircleGeometry(radius * 1.5, 20);
      blob = new THREE.Mesh(blobGeo, new THREE.MeshBasicMaterial({
        map: blobTex, color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false,
      }));
      blob.rotation.x = -Math.PI / 2;
      blob.renderOrder = 1;
      decorations.add(blob);
    }

    const body = new CANNON.Body({
      mass: spec.mass,
      material: materials.marble,
      shape: new CANNON.Sphere(radius),
      position: new CANNON.Vec3(startPositions[i].x, startPositions[i].y, startPositions[i].z),
    });
    body.linearDamping = spec.linDamp;
    body.angularDamping = spec.angDamp;
    // Only the player's collisions make sparks/sound — 100 marbles clattering would be a spark
    // firehose and an audio wall.
    if (onCollide && isPlayer) {
      body.addEventListener('collide', (e) => {
        const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
        if (v > 1.2) onCollide(v, body.position, RED);
      });
    }
    world.addBody(body);

    marbles.push({
      index: i, body, mesh, packIndex,
      trail, trailPos, blob,
      spec, radius, sphereGeo, blobGeo,
      finished: false, finishOrder: -1, place: -1, finishTime: 0,
      // prevPlace lets the director spot an overtake without re-deriving standings.
      prevPlace: -1,
      eliminated: false,
      speed: 0,
    });
  }

  // Seed the instance buffers from the starting grid. This is NOT redundant with sync(): the
  // pick phase never calls sync() (game.js _frame only syncs while racing or showing a result),
  // so without this the whole pack would render stacked at the world origin while the camera
  // frames the start gate.
  // Colour and atlas cell are seeded here too, and never touched again — both are constant for a
  // marble's whole life, so they cost nothing per frame.
  for (const m of marbles) {
    if (m.packIndex < 0) continue;
    _m4.compose(m.mesh.position, m.mesh.quaternion, _scale);
    pack.setMatrixAt(m.packIndex, _m4);
    _col.setHex(m.spec.color);
    pack.setColorAt(m.packIndex, _col);
    const cell = atlasCell(m.index);
    uvOffsets[m.packIndex * 2] = (cell % ATLAS_COLS) / ATLAS_COLS;
    uvOffsets[m.packIndex * 2 + 1] = ((cell / ATLAS_COLS) | 0) / ATLAS_ROWS;
  }
  pack.instanceMatrix.needsUpdate = true;
  pack.instanceColor.needsUpdate = true;
  packGeo.getAttribute('aUvOffset').needsUpdate = true;

  // Remove a marble that has fallen off the track: pull its body out of the
  // world (safe here — this runs from the frame loop, never inside a contact
  // callback) and hide its visuals. It no longer counts toward the race.
  function eliminate(m) {
    if (m.eliminated) return;
    m.eliminated = true;
    // Clear the stale placing. leaderboard() only ranks marbles still in the race, so an
    // eliminated marble would otherwise keep whatever place it held on the frame before it
    // fell — and a player eliminated while running 2nd would be scored a top-3 finish.
    m.place = -1;
    try { world.removeBody(m.body); } catch { }
    m.mesh.visible = false;
    // A pack marble has no Mesh to hide — `visible` on the proxy is inert. Collapse its instance
    // to zero scale instead, which is how an instance is "removed" without resizing the buffer.
    // sync() skips eliminated marbles, so this write is never undone.
    if (m.packIndex >= 0) {
      _m4.compose(m.body.position, m.mesh.quaternion, _zero);
      pack.setMatrixAt(m.packIndex, _m4);
      pack.instanceMatrix.needsUpdate = true;
    }
    if (m.trail) m.trail.visible = false;
    if (m.blob) m.blob.visible = false;
  }

  /**
   * Push physics transforms into the render meshes.
   *
   * @param {(z:number)=>number} [floorYAt] Centreline floor height at a forward Z. Optional —
   *   without it the contact blob falls back to riding under the marble as before. With it, the
   *   blob is planted on the ground and reacts to height (2026-08-08 realism pass #9).
   */
  function sync(floorYAt) {
    let packDirty = false;
    for (const m of marbles) {
      if (m.eliminated) continue;
      m.mesh.position.copy(m.body.position);
      m.mesh.quaternion.copy(m.body.quaternion);
      m.speed = m.body.velocity.length();

      // Pack marbles are drawn as instances: push the proxy's transform into the matrix buffer.
      // Colour is NOT written here — each marble's palette colour is constant and was seeded at
      // construction, so the per-frame cost is the transform alone.
      if (m.packIndex >= 0) {
        _m4.compose(m.mesh.position, m.mesh.quaternion, _scale);
        pack.setMatrixAt(m.packIndex, _m4);
        packDirty = true;
      }

      // Trail + blob belong to the player marble only (both null on the pack).
      if (m.trail) {
        // Trail: shift the buffer back one and write the new head (#6).
        const tp = m.trailPos;
        for (let j = TRAIL_LEN - 1; j > 0; j--) {
          tp[j * 3] = tp[(j - 1) * 3];
          tp[j * 3 + 1] = tp[(j - 1) * 3 + 1];
          tp[j * 3 + 2] = tp[(j - 1) * 3 + 2];
        }
        tp[0] = m.body.position.x; tp[1] = m.body.position.y; tp[2] = m.body.position.z;
        m.trail.geometry.attributes.position.needsUpdate = true;
      }
      // Contact blob (#8). 2026-08-08 realism pass #9: this used to be pinned a fixed distance
      // under the marble, so it flew with it — a "contact" shadow that left the ground the
      // moment the marble did, always the same size and always the same 50% black. A real one
      // stays on the floor and reads the gap: tight and dark on contact, wide and faint as the
      // marble climbs a berm or takes air off a kicker. That gap is the cue the eye uses to
      // judge height, and it is free here because the track can report its own floor.
      if (m.blob) {
        if (floorYAt) {
          const fy = floorYAt(m.body.position.z);
          // Height of the marble's underside above the floor, in radii.
          const gap = Math.max(0, (m.body.position.y - m.radius) - fy) / m.radius;
          // 0 at contact → 1 fully airborne, saturating at 6 radii up.
          const t = Math.min(1, gap / 6);
          m.blob.position.set(m.body.position.x, fy + 0.06, m.body.position.z);
          // Spread as it rises (1.0 → 2.2×) and fade hard (0.55 → 0.06).
          const s = 1 + t * 1.2;
          m.blob.scale.set(s, s, s);
          m.blob.material.opacity = 0.55 * (1 - t) * (1 - t) + 0.06;
          m.blob.visible = true;
        } else {
          m.blob.position.set(m.body.position.x, m.body.position.y - m.radius * 0.92, m.body.position.z);
        }
      }
    }
    // One upload per frame for the whole 100-marble pack, not one per marble. Only the matrices
    // move — instanceColor and the atlas offsets are static after construction.
    if (packDirty) pack.instanceMatrix.needsUpdate = true;
  }

  // Record finish order + time as marbles cross the finish plane. Returns
  // { allDone, justFinished } where justFinished lists marbles that crossed on
  // THIS tick (so the caller can fire confetti + a chime per finisher).
  // Stop a marble dead on the finish line: zero its motion and pull the body out
  // of the physics world so it freezes exactly where it crossed instead of rolling
  // off the end and falling. The mesh stays visible (sync keeps drawing it at the
  // frozen position), and with no body it can't block or bump trailing marbles.
  // Safe here — called from the frame loop, never inside a contact callback.
  function freezeMarble(m) {
    m.body.velocity.set(0, 0, 0);
    m.body.angularVelocity.set(0, 0, 0);
    try { world.removeBody(m.body); } catch { }
  }

  function checkFinishes(finishZ, raceClock) {
    const justFinished = [];
    for (const m of marbles) {
      if (m.eliminated || m.finished) continue;
      if (m.body.position.z >= finishZ) {
        m.finished = true;
        m.finishOrder = finishCounter++;
        m.finishTime = raceClock || 0;
        freezeMarble(m);
        justFinished.push(m);
      }
    }
    // The race is done once every marble still in it has finished (eliminated
    // marbles are out and no longer block completion).
    const allDone = marbles.every((m) => m.finished || m.eliminated);
    return { allDone, justFinished };
  }

  // Force-finish any stragglers (failsafe) ordered by current progress.
  function forceFinishRemaining(raceClock) {
    const rest = marbles.filter((m) => !m.finished && !m.eliminated).sort((a, b) => b.body.position.z - a.body.position.z);
    for (const m of rest) { m.finished = true; m.finishOrder = finishCounter++; m.finishTime = raceClock || 0; freezeMarble(m); }
  }

  // Live ordering (excludes eliminated marbles): finished first (by finish
  // order), then unfinished by progress.
  function leaderboard() {
    const order = marbles.filter((m) => !m.eliminated).sort((a, b) => {
      if (a.finished && b.finished) return a.finishOrder - b.finishOrder;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.body.position.z - a.body.position.z;
    });
    order.forEach((m, idx) => { m.place = idx + 1; });
    return order;
  }

  // Max progress (0..1) across the marbles still in the race — the LEADER's progress.
  function progress() {
    let max = 0;
    for (const m of marbles) { if (!m.eliminated) max = Math.max(max, m.body.position.z); }
    return Math.max(0, Math.min(1, max / TRACK.LENGTH));
  }

  // One marble's own progress (0..1). The HUD showed only progress() above, so the bar
  // tracked the leader — a player running last watched a bar that wasn't theirs fill up.
  function progressOf(m) {
    if (!m) return 0;
    return Math.max(0, Math.min(1, m.body.position.z / TRACK.LENGTH));
  }

  function dispose() {
    // The pack shares one geometry + one material — dispose them ONCE here, not per-marble.
    // The InstancedMesh owns the instance buffers, so disposing it releases those too.
    pack.dispose();
    packGeo.dispose();
    packMat.dispose();
    for (const m of marbles) {
      // Eliminated/finished marbles already had their body pulled out of the world.
      try { world.removeBody(m.body); } catch { }
      // Trail/blob/red-material/red-geometry are owned by the player marble only.
      if (m.trail) { m.trail.geometry.dispose(); m.trail.material.dispose(); }
      if (m.blob) m.blob.material.dispose();
      if (m.index === PLAYER_INDEX) {
        // The player's map is a CLONE of the atlas. Dispose the clone (it owns its own GPU
        // texture entry) but never the atlas itself — that's a module-level singleton shared by
        // every track, like the other procedural textures in this game.
        if (m.mesh.material.map) m.mesh.material.map.dispose();
        m.mesh.material.dispose();
        m.sphereGeo.dispose();
        if (m.blobGeo) m.blobGeo.dispose();
      }
    }
  }

  return { marbles, group, pack, decorations, sync, eliminate, checkFinishes, forceFinishRemaining, leaderboard, progress, progressOf, dispose };
}
