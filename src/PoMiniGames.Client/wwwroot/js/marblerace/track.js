// track.js — procedural descending ROAD: an asphalt floor (lumpy surface) edged by curved
// red/white kerb berms, with curves, banked turns, vertical undulation, channel pinches,
// friction bands, boost pads, telegraphed kicker bands, and five hazard zones (washboard
// ridges, plinko pins, pendulum bobs, turnstiles, and the motorised Gauntlet). Builds matching
// Three.js meshes and cannon-es bodies (the berm is visual; the wall COLLIDER stays at the road
// edge, so the tuned physics is unchanged).
//
// Non-trapping guarantee: obstacles scatter the pack hard, but nothing can hold a
// marble forever. Every obstacle is either curved, free-spinning, or motor-driven
// (so it always sweeps clear again), the channel never closes below two marble
// diameters, and the centerline is strictly descending. The pack CAN be wrecked;
// it cannot be stopped. (Zones are laid out along s in ZONES below — keep them
// non-overlapping when editing, the ribbons assume it.)
import * as THREE from 'three';
import * as CANNON from 'cannon-es';

export const TRACK = {
  LENGTH: 1800,       // forward (+Z) extent — lengthened for a longer race
  DROP: 760,          // 2× steeper ramp (slope ≈ 0.42) per request
  START_Y: 150,       // raised so the longer track keeps headroom for the descent
  CHANNEL_WIDTH: 64,  // base width (4× the old 16 per request); locally pinched by widthAt()
  // Raised hard alongside the sharper turns + boost pads: a marble leaving a pad at ~90 and
  // hitting a hairpin climbs the bank a long way, and a headless run over a harsh seed lost
  // 3 of 8 marbles over the top. Being wrecked by the chute is the point; being deleted by
  // it is not — an eliminated marble takes the player's whole run with it.
  WALL_HEIGHT: 44,
  WALL_THICK: 1.2,
  FLOOR_THICK: 4,     // thicker collider so fast marbles on the steep ramp can't tunnel through
  SEGMENTS: 520,      // scaled with LENGTH so the longer track still flows smoothly
  SEG_OVERLAP: 1.6,   // lengthwise overlap between floor boxes; see the seam note below
  MARBLE_R: 1.0,      // BASE radius — the roster scales each marble around this (see marbles.js)
};

// Zone layout along s (0 = gate, 1 = finish). Non-overlapping by construction so the
// floor ribbons for rumble/boost never z-fight and the hazards stay legible.
const ZONES = {
  RIDGES: { from: 0.10, to: 0.24, step: 0.045 },
  BOOST: [[0.26, 0.295], [0.615, 0.655], [0.835, 0.870]],
  PLINKO: { from: 0.31, to: 0.43, rows: 7 },
  KICKERS: [0.435, 0.455],  // #6 telegraphed push-only kick band (fits the plinko→rumble gap)
  RUMBLE: [[0.46, 0.50], [0.68, 0.72]],
  BOBS: { from: 0.52, to: 0.60, step: 0.04 },
  TURNSTILES: { from: 0.74, to: 0.82, step: 0.04 },
  GAUNTLET: { from: 0.885, to: 0.925, step: 0.02 },
  FINISH: [0.93, 1.0],
};

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);

// Procedural neon-grid texture for the chute surfaces (#9 — detailed surfaces). Built once.
let _gridTex = null;
function gridTexture() {
  if (_gridTex) return _gridTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#0c1430';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(90,150,230,0.55)';
  g.lineWidth = 2;
  for (let i = 0; i <= 256; i += 32) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 12);
  t.anisotropy = 4;
  _gridTex = t;
  return t;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Black-and-white checkerboard texture for the finish-line ground. Built once.
let _checkerTex = null;
function checkerTexture() {
  if (_checkerTex) return _checkerTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const n = 8, cs = 128 / n;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    g.fillStyle = ((x + y) & 1) ? '#0a0a0a' : '#f5f5f5';
    g.fillRect(x * cs, y * cs, cs, cs);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  _checkerTex = t;
  return t;
}

// Boost-pad texture: forward chevrons on a dark bed, so the pad reads as "this way, fast"
// rather than as another friction band. Built once.
let _boostTex = null;
function boostTexture() {
  if (_boostTex) return _boostTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#052b33';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#22d3ee';
  g.lineWidth = 9;
  g.lineCap = 'round';
  // Two chevrons pointing along +V (down-track once the ribbon UVs are applied).
  for (const yOff of [0, 64]) {
    g.beginPath();
    g.moveTo(18, yOff + 46);
    g.lineTo(64, yOff + 12);
    g.lineTo(110, yOff + 46);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  _boostTex = t;
  return t;
}

// Asphalt road surface: a dark bed flecked with aggregate speckle + faint longitudinal wear,
// so the ground reads as tarmac rather than a neon grid. Built once.
let _roadTex = null;
function roadTexture() {
  if (_roadTex) return _roadTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#1a2130'; g.fillRect(0, 0, 256, 256);
  for (let k = 0; k < 4600; k++) {
    const x = Math.random() * 256, y = Math.random() * 256, r = Math.random() * 1.5 + 0.3;
    const v = Math.random();
    g.fillStyle = v < 0.5 ? 'rgba(58,70,92,0.5)' : (v < 0.85 ? 'rgba(9,13,22,0.55)' : 'rgba(120,140,175,0.32)');
    g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
  }
  g.strokeStyle = 'rgba(90,150,230,0.05)'; g.lineWidth = 1;
  for (let x = 6; x < 256; x += 24) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + (Math.random() * 6 - 3), 256); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  _roadTex = t;
  return t;
}

// Racing-kerb stripes for the berms: transverse red/white bands (the universal "edge of the
// road" signal). The band axis is mapped to down-track V in buildBermRibbon, so the stripes run
// up-and-across the berm and repeat along the road like a real kerb. Built once.
let _kerbTex = null;
function kerbTexture() {
  if (_kerbTex) return _kerbTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#eef2f7'; g.fillRect(0, 0, 128, 128);   // white
  g.fillStyle = '#dc2626';                                // two red bands → 50% duty
  g.fillRect(0, 0, 128, 32);
  g.fillRect(0, 64, 128, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  _kerbTex = t;
  return t;
}

export function generateTrack(world, materials, seed, marbleCount = 8) {
  const rnd = mulberry32(seed);
  const group = new THREE.Group();
  const bodies = [];
  const turnstiles = []; // { body, mesh } — every dynamic obstacle, synced each frame
  const motors = [];     // { hinge, speed } — Gauntlet rotors, re-armed each frame

  // ── Centerline: linear descent in Y (with gentle undulation), lateral wander
  //    in X via three summed sines. Amplitudes AND frequencies are up again per
  //    request — curvature goes as amp*freq², so the turns are markedly sharper
  //    than the sweeping arcs this used to draw. The wide road is what makes them
  //    survivable: there is now room to take a line through a hairpin. ──
  const amp1 = 68 + rnd() * 54, freq1 = 1.8 + rnd() * 1.8, ph1 = rnd() * 6.28;
  const amp2 = 24 + rnd() * 30, freq2 = 3.4 + rnd() * 2.8, ph2 = rnd() * 6.28;
  const amp3 = 106 + rnd() * 46, freq3 = 0.6 + rnd() * 0.55, ph3 = rnd() * 6.28; // #2 sweeping S-curves

  // #3 vertical undulation: mild crests/dips layered on the linear descent. Kept to ONE gentle
  // octave in the PHYSICS centerline — a second, faster octave here made the floor-collider
  // segments step enough that the now-rolling marbles caught on the seams and the pack stalled.
  // The lumpy *look* is carried by bumpAt() on the visual ribbon instead (colliders stay smooth).
  // Kept small enough that dy/ds stays negative everywhere (undAmp*undFreq*π < DROP), so the run
  // is strictly descending and can never trap a marble.
  const undAmp = 7 + rnd() * 3, undFreq = 3.0 + rnd() * 1.5, undPh = rnd() * 6.28;

  // #7 lateral camber waves: an extra roll oscillation independent of turns, so
  // even straights tilt gently side to side and marbles drift laterally.
  const cambAmp = 0.10 + rnd() * 0.06, cambFreq = 2.5 + rnd() * 2.0, cambPh = rnd() * 6.28;

  const sample = (s) => {
    const z = s * TRACK.LENGTH;
    const x = amp1 * Math.sin(s * freq1 * Math.PI + ph1)
            + amp2 * Math.sin(s * freq2 * Math.PI + ph2)
            + amp3 * Math.sin(s * freq3 * Math.PI + ph3);
    const y = TRACK.START_Y - s * TRACK.DROP
            + undAmp * Math.sin(s * undFreq * Math.PI + undPh);
    return new THREE.Vector3(x, y, z);
  };

  // Visual surface lumpiness: a small per-vertex height noise added to the FLOOR RIBBON only
  // (the box colliders stay flat — the marbles are radius 1 so a ≤0.4 lump under them reads as
  // a rough, uneven road without the physics fighting it). Tapers to 0 at the road edges (u=±1)
  // so the floor still meets the berms cleanly.
  const bph1 = rnd() * 6.28, bph2 = rnd() * 6.28, bph3 = rnd() * 6.28, bph4 = rnd() * 6.28;
  const BUMP_AMP = 0.55;
  const bumpAt = (s, u) => {
    const z = s * TRACK.LENGTH;
    const n = Math.sin(z * 0.11 + u * 3.0 + bph1) * Math.sin(z * 0.047 + bph2)
            + 0.6 * Math.sin(z * 0.21 + u * 4.5 + bph3) * Math.cos(u * 2.2 + bph4);
    return BUMP_AMP * n * (1 - u * u);
  };

  // #4 channel-width pinches: two Gaussian "funnels" that squeeze the channel then
  // reopen. The first funnels the pack into the plinko field; the second bites just
  // before the run to the Gauntlet. Pinch depth is deeper than it was, because a 30%
  // pinch on a 64-wide road still leaves 45 units — wide enough that the whole pack
  // sails through and the funnel does nothing. Floored at 0.35 ⇒ never under ~22
  // units, still ~9× the widest marble, so it squeezes without ever plugging.
  const PINCHES = [
    { c: 0.37, w: 0.055, d: 0.52 },
    { c: 0.66, w: 0.050, d: 0.55 },
  ];
  const widthAt = (s) => {
    let f = 1;
    for (const p of PINCHES) f -= p.d * Math.exp(-((s - p.c) ** 2) / (2 * p.w * p.w));
    return TRACK.CHANNEL_WIDTH * Math.max(0.35, f);
  };

  // #5 rumble bands: floor stretches with real friction (everywhere else the
  // floor is frictionless). Marbles crossing them slow subtly and lose places.
  const inRumble = (s) => ZONES.RUMBLE.some(([a, b]) => s >= a && s <= b);
  // Boost pads: no collider of their own (marbles roll over the normal floor);
  // game.js reads inBoost() each frame and accelerates whatever is on top.
  const inBoost = (s) => ZONES.BOOST.some(([a, b]) => s >= a && s <= b);

  // Frame (position, tangent, right, up, bank quaternion) at parameter s.
  const frameAt = (s) => {
    const p = sample(s);
    const ahead = sample(Math.min(1, s + 0.004));
    const behind = sample(Math.max(0, s - 0.004));
    const dir = ahead.clone().sub(behind).normalize();
    const right = new THREE.Vector3().crossVectors(dir, UP).normalize();
    // bank into turns: proportional to how fast heading changes
    const hAhead = Math.atan2(ahead.x - p.x, ahead.z - p.z);
    const hBehind = Math.atan2(p.x - behind.x, p.z - behind.z);
    let dH = hAhead - hBehind;
    while (dH > Math.PI) dH -= 2 * Math.PI;
    while (dH < -Math.PI) dH += 2 * Math.PI;
    // Bank harder into the sharper turns: at 64 units wide, a banked corner lifts its
    // outer edge ~18 units, which is what keeps a fast marble from simply flying off the
    // outside of a hairpin. WALL_HEIGHT (30) is sized to stay above that.
    let bank = THREE.MathUtils.clamp(dH * 7, -0.5, 0.5);
    bank += cambAmp * Math.sin(s * cambFreq * Math.PI + cambPh); // #7 independent camber
    bank = THREE.MathUtils.clamp(bank, -0.6, 0.6);
    const q = new THREE.Quaternion().setFromUnitVectors(Z_AXIS, dir);
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(dir, bank));
    const up = UP.clone().applyQuaternion(q);
    const rb = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    return { p, dir, up, rb, q };
  };

  // Materials. Floor is now an ASPHALT ROAD — a matte-ish tarmac (rough, low metal, a whisper
  // of clearcoat for wet sheen) carrying the speckled road texture, so the ground reads as a
  // road surface rather than a neon grid. The grid is still used by the rumble/kicker bands.
  const grid = gridTexture();
  const road = roadTexture();
  const floorMat = new THREE.MeshPhysicalMaterial({
    color: 0x2a3446, emissive: 0x0a0f1c, emissiveIntensity: 0.16,
    roughness: 0.8, metalness: 0.1, clearcoat: 0.2, clearcoatRoughness: 0.7,
    map: road, roughnessMap: road,
  });
  // #5 rumble-band floor: warm amber so the friction stretches read at a glance.
  const rumbleFloorMat = new THREE.MeshPhysicalMaterial({
    color: 0x3a2410, emissive: 0xfb923c, emissiveIntensity: 0.55,
    roughness: 0.7, metalness: 0.15, clearcoat: 0.25, clearcoatRoughness: 0.5,
    map: grid, roughnessMap: grid,
  });
  // Boost pads: cyan chevrons, bright enough to read as the one *good* surface.
  const boostTex = boostTexture();
  const boostFloorMat = new THREE.MeshStandardMaterial({
    color: 0x0e7490, emissive: 0x22d3ee, emissiveIntensity: 0.75,
    roughness: 0.3, metalness: 0.2, map: boostTex,
  });
  // Berms replace the old flat cyan walls: red/white racing kerbs that curve up out of the road
  // edge (see buildBermRibbon). A faint emissive keeps them reading in the dark scene.
  const kerb = kerbTexture();
  const bermMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0x1a0303, emissiveIntensity: 0.18,
    roughness: 0.55, metalness: 0.15, map: kerb,
  });

  const addBody = (body) => { world.addBody(body); bodies.push(body); };

  // ── Floor + walls: box COLLIDERS only (physics). The visible surface is the
  //    smooth ribbon mesh built below — so the chute no longer looks like a
  //    string of faceted box fragments. ──
  for (let i = 0; i < TRACK.SEGMENTS; i++) {
    const s0 = i / TRACK.SEGMENTS;
    const s1 = (i + 1) / TRACK.SEGMENTS;
    const sMid = (s0 + s1) / 2;
    const p0 = sample(s0), p1 = sample(s1);
    const mid = p0.clone().add(p1).multiplyScalar(0.5);
    // Overlap so marbles never catch a seam. On the OUTSIDE of a turn the floor boxes fan
    // apart — the gap grows with half-width × the per-segment heading change, so widening
    // the road 4× and sharpening the turns both widen that gap. Hence 1.3 → SEG_OVERLAP.
    const segLen = p0.distanceTo(p1) * TRACK.SEG_OVERLAP;
    const { q, up, rb } = frameAt(sMid);
    const chW = widthAt(sMid);              // #4 local channel width
    const rumble = inRumble(sMid);          // #5 friction band?

    const floorPos = mid.clone().addScaledVector(up, -TRACK.FLOOR_THICK / 2);
    const floorBody = new CANNON.Body({ mass: 0, material: rumble ? materials.rumble : materials.surface });
    floorBody.addShape(new CANNON.Box(new CANNON.Vec3(chW / 2, TRACK.FLOOR_THICK / 2, segLen / 2)));
    floorBody.position.set(floorPos.x, floorPos.y, floorPos.z);
    floorBody.quaternion.set(q.x, q.y, q.z, q.w);
    addBody(floorBody);

    for (const sgn of [-1, 1]) {
      const wpos = mid.clone()
        .addScaledVector(rb, sgn * (chW / 2 + TRACK.WALL_THICK / 2))
        .addScaledVector(up, TRACK.WALL_HEIGHT / 2 - TRACK.FLOOR_THICK / 2);
      const wallBody = new CANNON.Body({ mass: 0, material: materials.surface });
      wallBody.addShape(new CANNON.Box(new CANNON.Vec3(TRACK.WALL_THICK / 2, TRACK.WALL_HEIGHT / 2, segLen / 2)));
      wallBody.position.set(wpos.x, wpos.y, wpos.z);
      wallBody.quaternion.set(q.x, q.y, q.z, q.w);
      addBody(wallBody);
    }
  }

  // ── Smooth visible chute: continuous ribbon meshes with per-vertex normals,
  //    so the floor and walls read as one smooth surface instead of stitched
  //    polygon fragments. The box colliders above still drive the physics. ──
  grid.repeat.set(1, 1);          // ribbon UVs carry the grid tiling now
  floorMat.side = THREE.DoubleSide;
  rumbleFloorMat.side = THREE.DoubleSide;
  boostFloorMat.side = THREE.DoubleSide;
  bermMat.side = THREE.DoubleSide;
  const RIBBON_N = Math.max(TRACK.SEGMENTS, 700);
  const CELL = 22;                // world units per texture tile
  const FLOOR_LAT = 8;            // lateral subdivisions of the floor ribbon (for the surface lumps)

  // Floor ribbon over [sA,sB], lifted `eps` above the collider top, tiling at `cell`. Subdivided
  // laterally and displaced by bumpAt() so the road surface is visibly lumpy/uneven.
  const buildFloorRibbon = (sA, sB, eps, cell) => {
    const steps = Math.max(2, Math.round(RIBBON_N * (sB - sA)));
    const cols = FLOOR_LAT + 1;
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= steps; i++) {
      const s = sA + (sB - sA) * (i / steps);
      const f = frameAt(s), w = widthAt(s);
      const v = (s * TRACK.LENGTH) / cell;
      for (let j = 0; j <= FLOOR_LAT; j++) {
        const u = (j / FLOOR_LAT) * 2 - 1;            // -1 (left rail) .. +1 (right rail)
        const lift = eps + bumpAt(s, u);
        const P = f.p.clone().addScaledVector(f.rb, u * w / 2).addScaledVector(f.up, lift);
        pos.push(P.x, P.y, P.z);
        uv.push((u * w / 2) / cell, v);
      }
      if (i < steps) {
        const row = i * cols, next = (i + 1) * cols;
        for (let j = 0; j < FLOOR_LAT; j++) {
          const a = row + j, b = row + j + 1, c = next + j, d = next + j + 1;
          idx.push(a, c, b, b, c, d);            // wind for upward-facing normals
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  };

  // ── Curved berms replace the flat vertical walls ──
  // Cross-section (outward lateral offset, height above the road edge), from the road edge
  // upward: a quarter-circle FILLET curls the road edge up and out (radius BERM_R), then a wall
  // continues to the top. So each side of the road curves smoothly up into a red/white kerb
  // instead of meeting a flat pane at a hard right angle. Physics is unchanged — the vertical
  // wall COLLIDER still sits at the road edge; the berm is the visible surface that curls around
  // it, and a marble held at the edge nestles into the curve.
  const BERM_R = 7;                              // fillet radius at the road edge
  const BERM_TOP = TRACK.WALL_HEIGHT;            // berm rises to the old wall height
  const bermProfile = (() => {
    const pts = [], F = 5;
    for (let k = 0; k <= F; k++) { const a = (k / F) * (Math.PI / 2); pts.push([BERM_R * Math.sin(a), BERM_R * (1 - Math.cos(a))]); }
    pts.push([BERM_R, BERM_TOP]);                // vertical run from the top of the fillet to full height
    return pts;
  })();
  const bermArc = (() => {
    const arc = [0];
    for (let k = 1; k < bermProfile.length; k++) {
      const dx = bermProfile[k][0] - bermProfile[k - 1][0], dy = bermProfile[k][1] - bermProfile[k - 1][1];
      arc.push(arc[k - 1] + Math.hypot(dx, dy));
    }
    return arc;
  })();

  const buildBermRibbon = (sgn) => {
    const M = bermProfile.length, BCELL = 9;     // BCELL tuned so the kerb stripes read
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= RIBBON_N; i++) {
      const s = i / RIBBON_N;
      const f = frameAt(s), w = widthAt(s);
      const edge = f.p.clone().addScaledVector(f.rb, sgn * (w / 2));
      const v = (s * TRACK.LENGTH) / BCELL;
      for (let k = 0; k < M; k++) {
        const [lat, h] = bermProfile[k];
        const P = edge.clone().addScaledVector(f.rb, sgn * lat).addScaledVector(f.up, h - TRACK.FLOOR_THICK / 2);
        pos.push(P.x, P.y, P.z);
        uv.push(bermArc[k] / BCELL, v);
      }
      if (i < RIBBON_N) {
        const row = i * M, next = (i + 1) * M;
        for (let k = 0; k < M - 1; k++) {
          const a = row + k, b = row + k + 1, c = next + k, d = next + k + 1;
          idx.push(a, b, c, b, d, c);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  };

  const floorMesh = new THREE.Mesh(buildFloorRibbon(0, 1, 0.0, CELL), floorMat);
  floorMesh.receiveShadow = true;
  group.add(floorMesh);

  // Amber rumble bands sit just above the main floor so their friction reads.
  for (const [a, b] of ZONES.RUMBLE) {
    const rm = new THREE.Mesh(buildFloorRibbon(a, b, 0.05, CELL), rumbleFloorMat);
    rm.receiveShadow = true;
    group.add(rm);
  }

  // Cyan boost pads. Tighter tiling than the rumble bands so the chevrons stay
  // legible over a short band.
  for (const [a, b] of ZONES.BOOST) {
    const bm = new THREE.Mesh(buildFloorRibbon(a, b, 0.05, 14), boostFloorMat);
    bm.receiveShadow = true;
    group.add(bm);
  }

  // #6 telegraphed KICKER band: push-only (no collider, like the boost pads) but it fires on a
  // cycle — charging up (brightening magenta) for a beat as a TELL, then flashing and shoving
  // whatever is crossing it hard sideways. Push-only means it scatters the pack and forces a
  // steering correction without ever being able to trap a marble (the non-trapping guarantee).
  // game.js reads `kickers` and drives both the tell (mat.emissiveIntensity ramp) and the
  // impulse (see _applyKickers). Magenta so it never reads as a friendly cyan boost.
  const kickerMat = new THREE.MeshStandardMaterial({
    color: 0x3b0a52, emissive: 0xe879f9, emissiveIntensity: 0.5,
    roughness: 0.35, metalness: 0.25, map: grid,
  });
  kickerMat.side = THREE.DoubleSide;
  const kickers = [];
  {
    const [a, b] = ZONES.KICKERS;
    const km = new THREE.Mesh(buildFloorRibbon(a, b, 0.06, 12), kickerMat);
    km.receiveShadow = true;
    group.add(km);
    // period: seconds per charge→fire cycle; _lastPhase: edge-detect the fire moment in game.js.
    kickers.push({ band: [a, b], mesh: km, mat: kickerMat, period: 2.6, _lastPhase: 0 });
  }

  for (const sgn of [-1, 1]) {
    const bm = new THREE.Mesh(buildBermRibbon(sgn), bermMat);
    bm.receiveShadow = true;
    bm.castShadow = true;
    group.add(bm);
  }

  // ── Obstacle materials. Per request, the ONLY spheres in the scene are the 8
  //    player marbles — every obstacle here is a cylinder or box primitive. ──
  const bumpMat = new THREE.MeshStandardMaterial({ color: 0x7c2d12, emissive: 0xfb923c, emissiveIntensity: 0.8, roughness: 0.5 });
  const pinMat = new THREE.MeshStandardMaterial({ color: 0x4a1d52, emissive: 0xe879f9, emissiveIntensity: 0.85, roughness: 0.4 });
  const padMat = new THREE.MeshStandardMaterial({ color: 0x14532d, emissive: 0x4ade80, emissiveIntensity: 0.85, roughness: 0.4, metalness: 0.2 });
  const rotorMat = new THREE.MeshStandardMaterial({ color: 0x7f1d1d, emissive: 0xf87171, emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.35 });

  // ZONE 1 — #6 washboard ridges: shallow transverse CYLINDERS the marbles roll
  // smoothly over, jostling the pack without pinballing it. The rounded top keeps
  // it non-blocking. cannon-es cylinders are Y-axis, so one rotation aligns both
  // the collider and the visual mesh across the channel.
  const ridgeR = TRACK.MARBLE_R * 0.9;
  for (let s = ZONES.RIDGES.from; s <= ZONES.RIDGES.to + 1e-6; s += ZONES.RIDGES.step) {
    const f = frameAt(s);
    const span = Math.max(6, widthAt(s) - 4);            // leave an edge gap both sides
    const bury = ridgeR * 0.55;                          // only the rounded top protrudes
    const ridgePos = f.p.clone().addScaledVector(f.up, -bury);
    const rq = f.q.clone().multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2));

    const rmesh = new THREE.Mesh(new THREE.CylinderGeometry(ridgeR, ridgeR, span, 16, 1), bumpMat);
    rmesh.quaternion.copy(rq);
    rmesh.position.copy(ridgePos);
    rmesh.castShadow = true;
    rmesh.receiveShadow = true;
    group.add(rmesh);

    const body = new CANNON.Body({ mass: 0, material: materials.bump });
    body.addShape(new CANNON.Cylinder(ridgeR, ridgeR, span, 14));
    body.quaternion.set(rq.x, rq.y, rq.z, rq.w);
    body.position.set(ridgePos.x, ridgePos.y, ridgePos.z);
    addBody(body);
  }

  // ZONE 2 — plinko pins: a staggered field of upright CYLINDERS that genuinely
  // scatters the pack. This is the main source of race-to-race variance; without
  // it the finishing order is mostly decided by the start grid. Pins are static
  // and vertical-ish (aligned to the local up), so a marble always deflects past.
  {
    const pinR = TRACK.MARBLE_R * 0.55, pinH = 4.0;
    const { from, to, rows } = ZONES.PLINKO;
    for (let r = 0; r < rows; r++) {
      const s = from + (to - from) * (r / (rows - 1));
      const f = frameAt(s);
      const w = widthAt(s);
      const usable = w - 6.0;                     // keep clear of both walls
      // Pin COUNT scales with the channel: a fixed 3-4 pins was tuned for a 16-wide chute
      // and would leave ~20-unit holes across a 64-wide one, which the pack would just pour
      // through. PIN_SPACING keeps the field at a constant density however wide the road is.
      // Rows alternate n and n+1 pins so the half-gap offset means there's never a straight
      // lane down the middle.
      const PIN_SPACING = 8.5;
      const base = Math.max(3, Math.round(usable / PIN_SPACING));
      const n = (r % 2 === 0) ? base : base + 1;
      for (let k = 0; k < n; k++) {
        const t = n === 1 ? 0.5 : k / (n - 1);
        const lateral = (t - 0.5) * usable;
        const pinPos = f.p.clone()
          .addScaledVector(f.rb, lateral)
          .addScaledVector(f.up, pinH / 2 - TRACK.FLOOR_THICK / 4);

        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(pinR, pinR, pinH, 12, 1), pinMat);
        mesh.position.copy(pinPos);
        mesh.quaternion.copy(f.q);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);

        const body = new CANNON.Body({ mass: 0, material: materials.obstacle });
        body.addShape(new CANNON.Cylinder(pinR, pinR, pinH, 10));
        body.position.set(pinPos.x, pinPos.y, pinPos.z);
        body.quaternion.set(f.q.x, f.q.y, f.q.z, f.q.w);
        addBody(body);
      }
    }
  }

  // ZONE 3 — #8 pendulum bobs: hinged BOXES (axis = tangent) that swing across
  // the channel, nudging marbles sideways. Far narrower than the channel, so
  // side gaps always remain — a nudge, never a wall.
  // A single centreline bob was a rounding error across a 64-wide road, so each station hangs
  // a ROW of them and the bobs are bigger.
  //
  // They are MOTOR-DRIVEN (windmills), not free-hanging pendulums, and that is a correctness
  // requirement rather than a flourish. The hinge axis is the track tangent, so the bob can
  // only swing sideways — a marble rolling into its face pushes along the one direction the
  // hinge forbids. With a frictionless floor and gravity holding the marble on, nothing ever
  // breaks the stalemate: headless runs parked three marbles at z≈950 at speed 0. One bob on
  // the centreline of a narrow chute mostly got missed; a row of them across a 64-wide road
  // is a wall. A motor that never stops always sweeps its arc clear, which restores the
  // non-trapping guarantee the free-swinging version only appeared to have.
  const bobR = TRACK.MARBLE_R * 2.2;
  const BOB_SPACING = 22;
  const BOB_SPREAD_MAX = 40;  // keep each arm's ±armLen arc off the walls
  // Hang the bob CLEAR of the floor. The anchor used to sit armLen above the centerline,
  // which put the bob's centre exactly at floor level — fine when the bob was a 2.6-unit
  // cube, fatal at 4.4: the box then intersected the static floor collider, the solver and
  // the hinge fought each other, and the jammed bob became a wall that stopped marbles dead
  // (headless: two marbles parked at z=931, speed 0). Anchoring at armLen + bobR + clearance
  // leaves the bob swinging just above the surface, where it still strikes a marble's upper
  // half but can never be pinned into the floor.
  const BOB_CLEARANCE = 0.6;
  let bobIdx = 0;
  for (let s = ZONES.BOBS.from; s <= ZONES.BOBS.to + 1e-6; s += ZONES.BOBS.step) {
    const f = frameAt(s);
    const armLen = 9; // swing arc; independent of WALL_HEIGHT
    // Spread is capped so neighbouring arms can't overlap each other's arc or reach a wall:
    // each bob sweeps ±armLen about its lateral position.
    const spread = Math.min(widthAt(s) - 10, BOB_SPREAD_MAX);
    const cols = Math.max(1, Math.round(spread / BOB_SPACING));

    for (let c = 0; c < cols; c++, bobIdx++) {
      const t = cols === 1 ? 0.5 : c / (cols - 1);
      const lateral = (t - 0.5) * spread;
      const startAngle = (bobIdx % 2 === 0 ? 1 : -1) * 0.6; // stagger the arms out of phase
      const anchorPos = f.p.clone()
        .addScaledVector(f.rb, lateral)
        .addScaledVector(f.up, armLen + bobR + BOB_CLEARANCE);
      const offset = f.up.clone().multiplyScalar(-armLen).applyAxisAngle(f.dir, startAngle);
      const bobPos = anchorPos.clone().add(offset);

      const mesh = new THREE.Mesh(new THREE.BoxGeometry(bobR * 2, bobR * 2, bobR * 2), pinMat);
      mesh.position.copy(bobPos);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);

      const anchor = new CANNON.Body({ mass: 0 });
      anchor.position.set(anchorPos.x, anchorPos.y, anchorPos.z);
      world.addBody(anchor);
      bodies.push(anchor);

      const bob = new CANNON.Body({ mass: 0.9, material: materials.obstacle });
      bob.addShape(new CANNON.Box(new CANNON.Vec3(bobR, bobR, bobR)));
      bob.position.set(bobPos.x, bobPos.y, bobPos.z);
      bob.angularDamping = 0.08;
      world.addBody(bob);
      bodies.push(bob);

      // Hinge about the tangent axis: anchor and bob are both unrotated, so local
      // == world. pivotA is the anchor itself; pivotB points from the bob back up
      // to the anchor (= -offset).
      const axis = new CANNON.Vec3(f.dir.x, f.dir.y, f.dir.z);
      const hinge = new CANNON.HingeConstraint(anchor, bob, {
        pivotA: new CANNON.Vec3(0, 0, 0), axisA: axis,
        pivotB: new CANNON.Vec3(-offset.x, -offset.y, -offset.z), axisB: axis,
        maxForce: 70,
      });
      // Windmill: alternating directions so adjacent arms cross rather than sweep in step.
      // Slow enough to read on screen, forceful enough to shift a 1.7-mass Heavyweight.
      const bobSpeed = (bobIdx % 2 === 0 ? 1 : -1) * (1.3 + rnd() * 0.6);
      hinge.enableMotor();
      hinge.setMotorSpeed(bobSpeed);
      hinge.setMotorMaxForce(70);
      world.addConstraint(hinge);
      motors.push({ hinge, speed: bobSpeed });
      turnstiles.push({ body: bob, mesh });
    }
  }

  // ZONE 4 — turnstiles: free-spinning hinged paddles shorter than the channel.
  for (let s = ZONES.TURNSTILES.from; s <= ZONES.TURNSTILES.to + 1e-6; s += ZONES.TURNSTILES.step) {
    const f = frameAt(s);
    const armLen = widthAt(s) * 0.30; // 2*armLen < channel ⇒ side gaps always remain
    const padH = 3.0, padThick = 0.8;
    const pivot = f.p.clone().addScaledVector(f.up, padH / 2);

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(armLen * 2, padH, padThick), padMat);
    mesh.position.copy(pivot);
    mesh.quaternion.copy(f.q);
    group.add(mesh);

    const anchor = new CANNON.Body({ mass: 0 });
    anchor.position.set(pivot.x, pivot.y, pivot.z);
    anchor.quaternion.set(f.q.x, f.q.y, f.q.z, f.q.w);
    world.addBody(anchor);
    bodies.push(anchor);

    const paddle = new CANNON.Body({ mass: 1.4, material: materials.obstacle });
    paddle.addShape(new CANNON.Box(new CANNON.Vec3(armLen, padH / 2, padThick / 2)));
    paddle.position.set(pivot.x, pivot.y, pivot.z);
    paddle.quaternion.set(f.q.x, f.q.y, f.q.z, f.q.w);
    paddle.angularDamping = 0.2;
    world.addBody(paddle);
    bodies.push(paddle);

    const axis = new CANNON.Vec3(0, 1, 0); // local up = hinge axis (banked with the frame)
    world.addConstraint(new CANNON.HingeConstraint(anchor, paddle, {
      pivotA: new CANNON.Vec3(0, 0, 0), axisA: axis,
      pivotB: new CANNON.Vec3(0, 0, 0), axisB: axis,
    }));
    turnstiles.push({ body: paddle, mesh });
  }

  // ZONE 5 — THE GAUNTLET: motor-driven rotors just before the finish. Unlike the
  // free-spinning turnstiles these are actively powered, so they hit back — a marble
  // can be flung sideways or knocked backwards, and a race can genuinely turn here.
  // This is the one place the pack gets wrecked on purpose.
  //
  // Non-trapping: the motor never stops, so a rotor always sweeps clear of whatever
  // it has pinned within half a revolution. Arms are 0.42 of the channel (vs 0.30
  // for turnstiles) — long enough to sweep most of it, short enough to leave a gap.
  let rotorIdx = 0;
  for (let s = ZONES.GAUNTLET.from; s <= ZONES.GAUNTLET.to + 1e-6; s += ZONES.GAUNTLET.step, rotorIdx++) {
    const f = frameAt(s);
    const armLen = widthAt(s) * 0.42;
    const padH = 3.4, padThick = 0.9;
    const pivot = f.p.clone().addScaledVector(f.up, padH / 2);

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(armLen * 2, padH, padThick), rotorMat);
    mesh.position.copy(pivot);
    mesh.quaternion.copy(f.q);
    mesh.castShadow = true;
    group.add(mesh);

    const anchor = new CANNON.Body({ mass: 0 });
    anchor.position.set(pivot.x, pivot.y, pivot.z);
    anchor.quaternion.set(f.q.x, f.q.y, f.q.z, f.q.w);
    world.addBody(anchor);
    bodies.push(anchor);

    const rotor = new CANNON.Body({ mass: 2.2, material: materials.spinner });
    rotor.addShape(new CANNON.Box(new CANNON.Vec3(armLen, padH / 2, padThick / 2)));
    rotor.position.set(pivot.x, pivot.y, pivot.z);
    rotor.quaternion.set(f.q.x, f.q.y, f.q.z, f.q.w);
    world.addBody(rotor);
    bodies.push(rotor);

    const axis = new CANNON.Vec3(0, 1, 0); // local up
    const hinge = new CANNON.HingeConstraint(anchor, rotor, {
      pivotA: new CANNON.Vec3(0, 0, 0), axisA: axis,
      pivotB: new CANNON.Vec3(0, 0, 0), axisB: axis,
      maxForce: 90,
    });
    // Alternate direction per rotor so consecutive rotors sweep against each other
    // and the pack can't just hug one wall through the whole zone.
    const speed = (rotorIdx % 2 === 0 ? 1 : -1) * (2.4 + rnd() * 1.2);
    hinge.enableMotor();
    hinge.setMotorSpeed(speed);
    hinge.setMotorMaxForce(90);
    world.addConstraint(hinge);
    motors.push({ hinge, speed });
    turnstiles.push({ body: rotor, mesh });
  }

  // ── Start marker + checkered finish-line ground ──
  const startF = frameAt(0.01);
  const finishF = frameAt(0.995);
  // Black-and-white checkerboard ground over the final stretch marks the finish.
  const checkerMat = new THREE.MeshStandardMaterial({
    map: checkerTexture(), roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide,
  });
  const checkerMesh = new THREE.Mesh(buildFloorRibbon(ZONES.FINISH[0], ZONES.FINISH[1], 0.06, 16), checkerMat);
  checkerMesh.receiveShadow = true;
  group.add(checkerMesh);

  // Start positions: a full starting field of `marbleCount` marbles (now 101) laid out in a
  // wide grid that fills the road across and stacks rows up-track, so nothing overlaps at spawn
  // and the pack immediately funnels into the first hazards together. All marbles are identical,
  // so the only thing to arrange for is spacing — the seeded shuffle the 8-marble roster needed
  // is gone.
  const usable = Math.max(12, widthAt(0.008) - 6);           // clear of both walls
  const COL_SPACING = 3.4;                                    // > one diameter (2) plus margin
  const cols = Math.max(1, Math.min(18, Math.floor(usable / COL_SPACING)));
  const rows = Math.ceil(marbleCount / cols);
  const span = Math.min(usable, (cols - 1) * COL_SPACING);
  const ROW_DS = 0.0045;                                      // s-step between rows (~8 units apart)
  const slotPositions = [];
  for (let slot = 0; slot < marbleCount; slot++) {
    const col = slot % cols;
    const row = Math.floor(slot / cols);
    const rowS = 0.008 + row * ROW_DS;
    const f = frameAt(rowS);
    const lateral = cols === 1 ? 0 : (col / (cols - 1) - 0.5) * span;
    slotPositions.push(f.p.clone()
      .addScaledVector(f.rb, lateral)
      .addScaledVector(f.up, TRACK.MARBLE_R * 1.25 + 0.6));
  }

  // Put the player's marble (index 0, the red one) in the MIDDLE of the pack rather than the
  // front-left corner — it starts on an even footing and there's a race in front of and behind
  // it. Swap its slot with the central one.
  const centralSlot = Math.min(marbleCount - 1,
    Math.floor(rows / 2) * cols + Math.floor(cols / 2));
  if (centralSlot > 0) {
    const tmp = slotPositions[0];
    slotPositions[0] = slotPositions[centralSlot];
    slotPositions[centralSlot] = tmp;
  }

  // Marble i spawns at slotPositions[i]. gridSlots is kept (identity) only so the return shape
  // is unchanged for any caller that still reads it.
  const gridSlots = Array.from({ length: marbleCount }, (_, i) => i);
  const startPositions = slotPositions;

  const sAt = (z) => Math.max(0, Math.min(1, z / TRACK.LENGTH));

  return {
    group,
    bodies,
    turnstiles,
    kickers,           // #6 telegraphed kicker bands — driven by game.js _applyKickers
    startPositions,
    gridSlots,
    length: TRACK.LENGTH,
    finishZ: finishF.p.z,
    overviewTarget: startF.p.clone(),
    boostBands: ZONES.BOOST,
    // Is the marble at forward position z standing on a boost pad? game.js applies
    // the acceleration itself — the pads are visual + a predicate, not colliders.
    inBoost: (z) => inBoost(sAt(z)),
    // Local track basis at a forward position, for the boost push (dir) and the
    // player's steering (rb).
    dirAt: (z) => frameAt(sAt(z)).dir,
    rightAt: (z) => frameAt(sAt(z)).rb,
    // #3 signed lateral position of a body across the channel: 0 = centerline, ±1 = at the
    // wall edge (clamped a little past for marbles climbing the bank). Drives the HUD edge
    // gauge so the player can see how close they are to steering off the track.
    lateralOf: (pos) => {
      const s = sAt(pos.z);
      const f = frameAt(s), w = widthAt(s);
      const lat = (pos.x - f.p.x) * f.rb.x + (pos.y - f.p.y) * f.rb.y + (pos.z - f.p.z) * f.rb.z;
      return Math.max(-1.4, Math.min(1.4, lat / (w / 2)));
    },
    // Cannon zeroes a motor's target the moment something stalls it hard; re-arming
    // every frame keeps the Gauntlet turning instead of seizing on a wedged marble.
    driveMotors() { for (const m of motors) m.hinge.setMotorSpeed(m.speed); },
    // Centerline (floor-top) Y at a given forward Z — used to detect marbles that
    // have fallen off the track (their Y drops well below this).
    floorY: (z) => sample(sAt(z)).y,
    dispose() {
      for (const b of bodies) world.removeBody(b);
      // constraints are removed with their bodies by cannon-es on removeBody
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
    },
  };
}
