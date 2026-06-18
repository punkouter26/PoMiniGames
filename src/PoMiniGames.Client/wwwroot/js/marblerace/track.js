// track.js — procedural descending neon chute (floor + walls) with curves & banked
// turns, plus three hazard zones. Builds matching Three.js meshes and cannon-es bodies.
//
// Non-blocking guarantee: every obstacle is curved (spheres) or free-spinning (hinged
// paddles shorter than the channel), and the floor is frictionless and steep, so nothing
// can ever fully stop a marble's descent.
import * as THREE from 'three';
import * as CANNON from 'cannon-es';

export const TRACK = {
  LENGTH: 220,        // forward (+Z) extent
  DROP: 86,           // total vertical drop over the length — steeper so gravity always wins (no stalls)
  START_Y: 70,
  CHANNEL_WIDTH: 16,
  WALL_HEIGHT: 7,     // taller walls so the steeper/bouncier run can't throw a marble off the track
  WALL_THICK: 1.2,
  FLOOR_THICK: 2,
  SEGMENTS: 80,
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
  t.repeat.set(2, 8);
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

export function generateTrack(world, materials, seed) {
  const rnd = mulberry32(seed);
  const group = new THREE.Group();
  const bodies = [];
  const turnstiles = []; // { body, mesh }

  // ── Centerline: linear descent in Y, lateral wander in X via summed sines ──
  const amp1 = 18 + rnd() * 14, freq1 = 1.5 + rnd() * 1.5, ph1 = rnd() * 6.28;
  const amp2 = 6 + rnd() * 8, freq2 = 3.0 + rnd() * 2.5, ph2 = rnd() * 6.28;
  const sample = (s) => {
    const z = s * TRACK.LENGTH;
    const x = amp1 * Math.sin(s * freq1 * Math.PI + ph1) + amp2 * Math.sin(s * freq2 * Math.PI + ph2);
    const y = TRACK.START_Y - s * TRACK.DROP;
    return new THREE.Vector3(x, y, z);
  };

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
    const bank = THREE.MathUtils.clamp(dH * 7, -0.32, 0.32);
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
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x0b3550, emissive: 0x22d3ee, emissiveIntensity: 0.95, roughness: 0.35, metalness: 0.3 });

  const addBody = (body) => { world.addBody(body); bodies.push(body); };

  // ── Floor + walls as oriented box segments ──
  const floorGeoCache = new THREE.BoxGeometry(1, 1, 1);
  for (let i = 0; i < TRACK.SEGMENTS; i++) {
    const s0 = i / TRACK.SEGMENTS;
    const s1 = (i + 1) / TRACK.SEGMENTS;
    const p0 = sample(s0), p1 = sample(s1);
    const mid = p0.clone().add(p1).multiplyScalar(0.5);
    const segLen = p0.distanceTo(p1) * 1.3; // generous overlap so frictionless marbles never catch a seam
    const { q, up, rb } = frameAt((s0 + s1) / 2);

    // floor: wide (x), thin (y), long (z); top surface at centerline
    const floor = new THREE.Mesh(floorGeoCache, floorMat);
    floor.scale.set(TRACK.CHANNEL_WIDTH, TRACK.FLOOR_THICK, segLen);
    const floorPos = mid.clone().addScaledVector(up, -TRACK.FLOOR_THICK / 2);
    floor.position.copy(floorPos);
    floor.quaternion.copy(q);
    floor.receiveShadow = true;
    group.add(floor);

    const floorBody = new CANNON.Body({ mass: 0, material: materials.surface });
    floorBody.addShape(new CANNON.Box(new CANNON.Vec3(TRACK.CHANNEL_WIDTH / 2, TRACK.FLOOR_THICK / 2, segLen / 2)));
    floorBody.position.set(floorPos.x, floorPos.y, floorPos.z);
    floorBody.quaternion.set(q.x, q.y, q.z, q.w);
    addBody(floorBody);

    // walls: thin (x), tall (y), long (z) on both edges
    for (const sgn of [-1, 1]) {
      const wall = new THREE.Mesh(floorGeoCache, wallMat);
      wall.scale.set(TRACK.WALL_THICK, TRACK.WALL_HEIGHT, segLen);
      const wpos = mid.clone()
        .addScaledVector(rb, sgn * (TRACK.CHANNEL_WIDTH / 2 + TRACK.WALL_THICK / 2))
        .addScaledVector(up, TRACK.WALL_HEIGHT / 2 - TRACK.FLOOR_THICK / 2);
      wall.position.copy(wpos);
      wall.quaternion.copy(q);
      wall.receiveShadow = true;
      group.add(wall);

      const wallBody = new CANNON.Body({ mass: 0, material: materials.surface });
      wallBody.addShape(new CANNON.Box(new CANNON.Vec3(TRACK.WALL_THICK / 2, TRACK.WALL_HEIGHT / 2, segLen / 2)));
      wallBody.position.set(wpos.x, wpos.y, wpos.z);
      wallBody.quaternion.set(q.x, q.y, q.z, q.w);
      addBody(wallBody);
    }
  }

  // ── Obstacle helpers ──
  const sphereGeo = new THREE.SphereGeometry(1, 18, 14);
  const bumpMat = new THREE.MeshStandardMaterial({ color: 0x7c2d12, emissive: 0xfb923c, emissiveIntensity: 0.8, roughness: 0.5 });
  const pinMat = new THREE.MeshStandardMaterial({ color: 0x4a1d52, emissive: 0xe879f9, emissiveIntensity: 0.85, roughness: 0.4 });
  const padMat = new THREE.MeshStandardMaterial({ color: 0x14532d, emissive: 0x4ade80, emissiveIntensity: 0.85, roughness: 0.4, metalness: 0.2 });

  const addStaticSphere = (pos, r, mat) => {
    const mesh = new THREE.Mesh(sphereGeo, mat);
    mesh.scale.setScalar(r);
    mesh.position.copy(pos);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    const body = new CANNON.Body({ mass: 0, material: materials.obstacle });
    body.addShape(new CANNON.Sphere(r));
    body.position.set(pos.x, pos.y, pos.z);
    addBody(body);
  };

  // ZONE 1 — speed bumps: a few rows of low, half-buried spheres (curved → roll over, lose speed).
  // Sparse (2 per row, 3 rows) with wide gaps so a marble can never be wedged between bumps.
  for (let s = 0.13; s <= 0.27; s += 0.07) {
    const f = frameAt(s);
    const r = TRACK.MARBLE_R * 0.95;
    const count = 2;
    for (let k = 0; k < count; k++) {
      const t = (k / (count - 1) - 0.5) * (TRACK.CHANNEL_WIDTH - 6);
      const pos = f.p.clone().addScaledVector(f.rb, t).addScaledVector(f.up, -r * 0.55);
      addStaticSphere(pos, r, bumpMat);
    }
  }

  // ZONE 2 — Plinko pins: staggered grid of narrow pegs. Wider spacing + fewer rows so the
  // gaps stay comfortably larger than a marble diameter and the pack flows through.
  let row = 0;
  for (let s = 0.42; s <= 0.62; s += 0.06, row++) {
    const f = frameAt(s);
    const r = TRACK.MARBLE_R * 0.9;
    const spacing = 5.0;
    const offset = (row % 2 === 0) ? 0 : spacing / 2;
    const span = TRACK.CHANNEL_WIDTH - 4;
    for (let x = -span / 2 + offset; x <= span / 2; x += spacing) {
      const pos = f.p.clone().addScaledVector(f.rb, x).addScaledVector(f.up, r);
      addStaticSphere(pos, r, pinMat);
    }
  }

  // ZONE 3 — turnstiles: free-spinning hinged paddles shorter than the channel
  for (let s = 0.74; s <= 0.90; s += 0.09) {
    const f = frameAt(s);
    const armLen = TRACK.CHANNEL_WIDTH * 0.30; // 2*armLen < channel ⇒ side gaps always remain
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

  // Extra bumpers for variety — one peg in each gap between zones. Kept small and pulled
  // well clear of the wall so a marble can never wedge between the peg and the wall.
  for (const s of [0.34, 0.66]) {
    const f = frameAt(s);
    const r = TRACK.MARBLE_R * 0.9;
    const side = (s < 0.5) ? -1 : 1;
    const pos = f.p.clone().addScaledVector(f.rb, side * (TRACK.CHANNEL_WIDTH / 2 - 3.4)).addScaledVector(f.up, r);
    addStaticSphere(pos, r, pinMat);
  }

  // ── Start gate marker + finish line band ──
  const startF = frameAt(0.01);
  const finishF = frameAt(0.995);
  const bandGeo = new THREE.PlaneGeometry(TRACK.CHANNEL_WIDTH, 4);
  const finishMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfde047, emissiveIntensity: 1.0, side: THREE.DoubleSide });
  const finishBand = new THREE.Mesh(bandGeo, finishMat);
  finishBand.position.copy(finishF.p.clone().addScaledVector(finishF.up, 0.2));
  finishBand.quaternion.copy(finishF.q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)));
  group.add(finishBand);

  // Start positions: a 4×2 staggered grid so no two marbles overlap at spawn
  // (8 marbles can't fit in one row without their radii intersecting).
  const startPositions = [];
  const perRow = 4;
  for (let i = 0; i < 8; i++) {
    const col = i % perRow;
    const rowS = 0.008 + Math.floor(i / perRow) * 0.016; // second row slightly up-track
    const f = frameAt(rowS);
    const lateral = (col / (perRow - 1) - 0.5) * (TRACK.CHANNEL_WIDTH - 6); // ~3.3 spacing > diameter
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
    dispose() {
      for (const b of bodies) world.removeBody(b);
      // constraints are removed with their bodies by cannon-es on removeBody
      group.traverse((o) => {
        if (o.geometry && o.geometry !== floorGeoCache && o.geometry !== sphereGeo) o.geometry.dispose();
      });
    },
  };
}
