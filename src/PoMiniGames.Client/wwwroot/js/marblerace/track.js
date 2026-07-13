// track.js — procedural descending neon chute (floor + walls) with curves, banked
// turns, vertical undulation, channel pinches, friction bands, and four subtle
// hazard zones (washboard ridges, turnstiles, pendulum bobs). Builds matching
// Three.js meshes and cannon-es bodies.
//
// Non-blocking guarantee: every obstacle is curved (spheres), free-spinning
// (hinged paddles / pendulum bobs shorter than the channel), or purely a friction
// patch, and the floor is steep with a strictly-descending centerline, so nothing
// can ever fully stop a marble's descent.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';

export const TRACK = {
  LENGTH: 1800,       // forward (+Z) extent — lengthened for a longer race
  DROP: 760,          // 2× steeper ramp (slope ≈ 0.42) per request
  START_Y: 150,       // raised so the longer track keeps headroom for the descent
  CHANNEL_WIDTH: 16,  // base width; locally pinched by widthAt()
  WALL_HEIGHT: 24,    // doubled + semi-transparent so fast marbles on sharp turns stay on the track
  WALL_THICK: 1.2,
  FLOOR_THICK: 4,     // thicker collider so fast marbles on the steep ramp can't tunnel through
  SEGMENTS: 520,      // scaled with LENGTH so the longer track still flows smoothly
  MARBLE_R: 1.0,
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

export function generateTrack(world, materials, seed) {
  const rnd = mulberry32(seed);
  const group = new THREE.Group();
  const bodies = [];
  const turnstiles = []; // { body, mesh } — turnstile paddles AND pendulum bobs (both synced each frame)

  // ── Centerline: linear descent in Y (with gentle undulation), lateral wander
  //    in X via three summed sines. Amplitudes are 2× the earlier values so the
  //    turns are twice as sharp (curvature scales with amplitude at fixed freq). ──
  const amp1 = 36 + rnd() * 28, freq1 = 1.5 + rnd() * 1.5, ph1 = rnd() * 6.28;
  const amp2 = 12 + rnd() * 16, freq2 = 3.0 + rnd() * 2.5, ph2 = rnd() * 6.28;
  const amp3 = 56 + rnd() * 24, freq3 = 0.55 + rnd() * 0.5, ph3 = rnd() * 6.28; // #2 sweeping S-curves

  // #3 vertical undulation: mild crests/dips layered on the linear descent.
  // Kept small enough that dy/ds stays negative everywhere (undAmp*undFreq*π <
  // DROP), so the run is strictly descending and can never trap a marble.
  const undAmp = 7 + rnd() * 3, undFreq = 3.0 + rnd() * 1.5, undPh = rnd() * 6.28;

  // #7 lateral camber waves: an extra roll oscillation independent of turns, so
  // even straights tilt gently side to side and marbles drift laterally.
  const cambAmp = 0.10 + rnd() * 0.06, cambFreq = 2.5 + rnd() * 2.0, cambPh = rnd() * 6.28;

  const sample = (s) => {
    const z = s * TRACK.LENGTH;
    const x = amp1 * Math.sin(s * freq1 * Math.PI + ph1)
            + amp2 * Math.sin(s * freq2 * Math.PI + ph2)
            + amp3 * Math.sin(s * freq3 * Math.PI + ph3);
    const y = TRACK.START_Y - s * TRACK.DROP + undAmp * Math.sin(s * undFreq * Math.PI + undPh);
    return new THREE.Vector3(x, y, z);
  };

  // #4 channel-width pinches: two Gaussian "funnels" that squeeze the channel
  // ~30% then reopen. Stays well wider than two marble diameters, so gentle
  // overtake battles happen without any blocking geometry.
  const PINCHES = [
    { c: 0.40, w: 0.055, d: 0.30 },
    { c: 0.63, w: 0.050, d: 0.32 },
  ];
  const widthAt = (s) => {
    let f = 1;
    for (const p of PINCHES) f -= p.d * Math.exp(-((s - p.c) ** 2) / (2 * p.w * p.w));
    return TRACK.CHANNEL_WIDTH * Math.max(0.6, f);
  };

  // #5 rumble bands: floor stretches with real friction (everywhere else the
  // floor is frictionless). Marbles crossing them slow subtly and lose places.
  const RUMBLE_BANDS = [[0.31, 0.36], [0.54, 0.59], [0.80, 0.85]];
  const inRumble = (s) => RUMBLE_BANDS.some(([a, b]) => s >= a && s <= b);

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
    let bank = THREE.MathUtils.clamp(dH * 7, -0.32, 0.32);
    bank += cambAmp * Math.sin(s * cambFreq * Math.PI + cambPh); // #7 independent camber
    bank = THREE.MathUtils.clamp(bank, -0.42, 0.42);
    const q = new THREE.Quaternion().setFromUnitVectors(Z_AXIS, dir);
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(dir, bank));
    const up = UP.clone().applyQuaternion(q);
    const rb = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    return { p, dir, up, rb, q };
  };

  // Materials (neon, emissive on dark). Floor is a glossy clearcoat surface (#5) carrying the
  // neon grid (#9) so it catches reflections from the environment map and bloom highlights.
  const grid = gridTexture();
  const floorMat = new THREE.MeshPhysicalMaterial({
    color: 0x16203c, emissive: 0x0e1b3a, emissiveIntensity: 0.5,
    roughness: 0.35, metalness: 0.25, clearcoat: 0.85, clearcoatRoughness: 0.3,
    map: grid, roughnessMap: grid,
  });
  // #5 rumble-band floor: warm amber so the friction stretches read at a glance.
  const rumbleFloorMat = new THREE.MeshPhysicalMaterial({
    color: 0x3a2410, emissive: 0xfb923c, emissiveIntensity: 0.55,
    roughness: 0.7, metalness: 0.15, clearcoat: 0.25, clearcoatRoughness: 0.5,
    map: grid, roughnessMap: grid,
  });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x0b3550, emissive: 0x22d3ee, emissiveIntensity: 0.95, roughness: 0.35, metalness: 0.3, transparent: true, opacity: 0.5 });

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
    const segLen = p0.distanceTo(p1) * 1.3; // overlap so marbles never catch a seam
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
  wallMat.side = THREE.DoubleSide;
  const RIBBON_N = Math.max(TRACK.SEGMENTS, 700);
  const CELL = 22;                // world units per texture tile

  // Floor ribbon over [sA,sB], lifted `eps` above the collider top, tiling `tex`.
  const buildFloorRibbon = (sA, sB, eps, cell) => {
    const steps = Math.max(2, Math.round(RIBBON_N * (sB - sA)));
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= steps; i++) {
      const s = sA + (sB - sA) * (i / steps);
      const f = frameAt(s), w = widthAt(s);
      const L = f.p.clone().addScaledVector(f.rb, -w / 2).addScaledVector(f.up, eps);
      const R = f.p.clone().addScaledVector(f.rb, w / 2).addScaledVector(f.up, eps);
      pos.push(L.x, L.y, L.z, R.x, R.y, R.z);
      const v = (s * TRACK.LENGTH) / cell;
      uv.push(-(w / 2) / cell, v, (w / 2) / cell, v);
      if (i < steps) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  };

  const buildWallRibbon = (sgn) => {
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= RIBBON_N; i++) {
      const s = i / RIBBON_N;
      const f = frameAt(s), w = widthAt(s);
      const edge = f.p.clone().addScaledVector(f.rb, sgn * (w / 2));
      const bot = edge.clone().addScaledVector(f.up, -TRACK.FLOOR_THICK / 2);
      const top = edge.clone().addScaledVector(f.up, TRACK.WALL_HEIGHT - TRACK.FLOOR_THICK / 2);
      pos.push(bot.x, bot.y, bot.z, top.x, top.y, top.z);
      const v = (s * TRACK.LENGTH) / CELL;
      uv.push(0, v, TRACK.WALL_HEIGHT / CELL, v);
      if (i < RIBBON_N) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
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
  for (const [a, b] of RUMBLE_BANDS) {
    const rm = new THREE.Mesh(buildFloorRibbon(a, b, 0.05, CELL), rumbleFloorMat);
    rm.receiveShadow = true;
    group.add(rm);
  }

  for (const sgn of [-1, 1]) {
    const wm = new THREE.Mesh(buildWallRibbon(sgn), wallMat);
    wm.receiveShadow = true;
    group.add(wm);
  }

  // ── Obstacle materials. Per request, the ONLY spheres in the scene are the 8
  //    player marbles — every obstacle here is a cylinder or box primitive. ──
  const bumpMat = new THREE.MeshStandardMaterial({ color: 0x7c2d12, emissive: 0xfb923c, emissiveIntensity: 0.8, roughness: 0.5 });
  const pinMat = new THREE.MeshStandardMaterial({ color: 0x4a1d52, emissive: 0xe879f9, emissiveIntensity: 0.85, roughness: 0.4 });
  const padMat = new THREE.MeshStandardMaterial({ color: 0x14532d, emissive: 0x4ade80, emissiveIntensity: 0.85, roughness: 0.4, metalness: 0.2 });

  // ZONE 1 — #6 washboard ridges: shallow transverse CYLINDERS the marbles roll
  // smoothly over, jostling the pack without pinballing it. The rounded top keeps
  // it non-blocking. cannon-es cylinders are Y-axis, so one rotation aligns both
  // the collider and the visual mesh across the channel.
  const ridgeR = TRACK.MARBLE_R * 0.9;
  for (let s = 0.12; s <= 0.30 + 1e-6; s += 0.045) {
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

  // ZONE 2 — Plinko pins removed (player request): the pink pegs that used to scatter
  // the pack are gone, so the marbles flow down a much smoother chute now.

  // ZONE 3 — turnstiles: free-spinning hinged paddles shorter than the channel.
  for (let s = 0.72; s <= 0.90 + 1e-6; s += 0.09) {
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

  // ZONE 4 — #8 pendulum bobs: hinged BOXES (axis = tangent) that swing across
  // the channel, nudging marbles sideways. Far narrower than the channel, so
  // side gaps always remain — a nudge, never a wall.
  const bobR = TRACK.MARBLE_R * 1.3;
  let bobIdx = 0;
  for (let s = 0.46; s <= 0.58 + 1e-6; s += 0.06, bobIdx++) {
    const f = frameAt(s);
    const armLen = 9; // fixed so it's independent of WALL_HEIGHT — bob hangs to ~floor level
    const startAngle = (bobIdx % 2 === 0 ? 1 : -1) * 0.6; // offset so gravity swings it
    const anchorPos = f.p.clone().addScaledVector(f.up, armLen);
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
    world.addConstraint(new CANNON.HingeConstraint(anchor, bob, {
      pivotA: new CANNON.Vec3(0, 0, 0), axisA: axis,
      pivotB: new CANNON.Vec3(-offset.x, -offset.y, -offset.z), axisB: axis,
    }));
    turnstiles.push({ body: bob, mesh });
  }

  // ── Start marker + checkered finish-line ground ──
  const startF = frameAt(0.01);
  const finishF = frameAt(0.995);
  // Black-and-white checkerboard ground over the final stretch marks the finish.
  const checkerMat = new THREE.MeshStandardMaterial({
    map: checkerTexture(), roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide,
  });
  const checkerMesh = new THREE.Mesh(buildFloorRibbon(0.93, 1.0, 0.06, 16), checkerMat);
  checkerMesh.receiveShadow = true;
  group.add(checkerMesh);

  // Start positions: a 4×2 staggered grid so no two marbles overlap at spawn
  // (8 marbles can't fit in one row without their radii intersecting).
  const startPositions = [];
  const perRow = 4;
  for (let i = 0; i < 8; i++) {
    const col = i % perRow;
    const rowS = 0.008 + Math.floor(i / perRow) * 0.016; // second row slightly up-track
    const f = frameAt(rowS);
    const lateral = (col / (perRow - 1) - 0.5) * (widthAt(rowS) - 6); // ~3.3 spacing > diameter
    startPositions.push(f.p.clone()
      .addScaledVector(f.rb, lateral)
      .addScaledVector(f.up, TRACK.MARBLE_R + 0.6));
  }

  return {
    group,
    bodies,
    turnstiles,
    startPositions,
    length: TRACK.LENGTH,
    finishZ: finishF.p.z,
    overviewTarget: startF.p.clone(),
    // Centerline (floor-top) Y at a given forward Z — used to detect marbles that
    // have fallen off the track (their Y drops well below this).
    floorY: (z) => sample(Math.max(0, Math.min(1, z / TRACK.LENGTH))).y,
    dispose() {
      for (const b of bodies) world.removeBody(b);
      // constraints are removed with their bodies by cannon-es on removeBody
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
    },
  };
}
