// fighters.js — the four president caricatures as hierarchical three.js primitive rigs.
// Silhouette identity comes from hair geometry, suit/tie palette and height/build scale;
// faces stay abstract so the caricature reads as playful, not mocking.
//
// Each character exposes `mass`, `attackPower`, and `moveAccel` so the engine can drive
// realistic weight/momentum/knockback without per-character special cases.
// Materials are MeshStandardMaterial so we can pick up the arena env map and react
// to the key/rim lights.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const CHARACTERS = {
  trump: {
    id: 'trump', name: 'Trump',
    skin: 0xf0b98a, suit: 0x1b2a52, tie: 0xd62828, tieLength: 1.4,
    hair: 0xf5d47a, hairStyle: 'sweep',
    heightScale: 1.02, buildScale: 1.15,
    mass: 1.18, attackPower: 1.10, moveAccel: 11,
    entrance: 'swagger',
  },
  biden: {
    id: 'biden', name: 'Biden',
    skin: 0xe8bfa4, suit: 0x24365e, tie: 0x7fb2e5, tieLength: 1.0,
    hair: 0xf2f2f2, hairStyle: 'comb',
    heightScale: 1.0, buildScale: 0.95, aviators: true,
    mass: 0.95, attackPower: 0.92, moveAccel: 13,
    entrance: 'aviator',
  },
  obama: {
    id: 'obama', name: 'Obama',
    skin: 0x8d5524, suit: 0x3a3f44, tie: 0x2456c9, tieLength: 1.0,
    hair: 0x2b2b2b, hairStyle: 'cap',
    heightScale: 1.04, buildScale: 0.95,
    mass: 1.0, attackPower: 1.05, moveAccel: 14,
    entrance: 'fistbump',
  },
  bush: {
    id: 'bush', name: 'Bush',
    skin: 0xe3b18e, suit: 0x17181c, tie: 0xb02323, tieLength: 0.85,
    hair: 0x8a8073, hairStyle: 'cap',
    heightScale: 0.97, buildScale: 1.08,
    mass: 1.12, attackPower: 1.0, moveAccel: 10,
    entrance: 'cowboy',
  },
  clinton: {
    id: 'clinton', name: 'Clinton',
    skin: 0xeec39a, suit: 0x2c3e6b, tie: 0xc0392b, tieLength: 1.05,
    hair: 0xd9d9d9, hairStyle: 'sweep',
    heightScale: 1.03, buildScale: 1.06,
    mass: 1.08, attackPower: 1.02, moveAccel: 12,
    entrance: 'thumbsup',
  },
  bushsr: {
    id: 'bushsr', name: 'Bush Sr.',
    skin: 0xe5c0a0, suit: 0x3b4a63, tie: 0x30549c, tieLength: 0.95,
    hair: 0xbfb8ae, hairStyle: 'comb',
    heightScale: 1.04, buildScale: 0.92,
    mass: 0.98, attackPower: 0.98, moveAccel: 13,
    entrance: 'salute',
  },
  reagan: {
    id: 'reagan', name: 'Reagan',
    skin: 0xe0a884, suit: 0x5a3a35, tie: 0x99282e, tieLength: 1.0,
    hair: 0x442e1f, hairStyle: 'sweep',
    heightScale: 1.02, buildScale: 1.0,
    mass: 1.05, attackPower: 1.08, moveAccel: 12,
    entrance: 'salute',
  },
  carter: {
    id: 'carter', name: 'Carter',
    skin: 0xe6bd9d, suit: 0x6b7a8f, tie: 0x3f7a4d, tieLength: 0.95,
    hair: 0x9c9587, hairStyle: 'cap',
    heightScale: 0.99, buildScale: 0.9,
    mass: 0.92, attackPower: 0.95, moveAccel: 14,
    entrance: 'salute',
  },
  ford: {
    id: 'ford', name: 'Ford',
    skin: 0xe8c2a4, suit: 0x2f3a4a, tie: 0x8f6b2f, tieLength: 0.9,
    hair: 0xcdb98e, hairStyle: 'balding',
    heightScale: 1.05, buildScale: 1.1,
    mass: 1.15, attackPower: 1.06, moveAccel: 11,
    entrance: 'salute',
  },
  nixon: {
    id: 'nixon', name: 'Nixon',
    skin: 0xe2b492, suit: 0x23252b, tie: 0x5d6d7e, tieLength: 1.0,
    hair: 0x3a3129, hairStyle: 'widow',
    heightScale: 1.0, buildScale: 1.12,
    mass: 1.2, attackPower: 1.12, moveAccel: 12,
    entrance: 'salute',
  },
  // BOB — the 1-player everyman hero. No suit: white tee, blue jeans,
  // sneakers, messy brown hair. Built by the same rig with `outfit: 'casual'`.
  bob: {
    id: 'bob', name: 'BOB',
    skin: 0xdfae8f, hair: 0x5a3d24, hairStyle: 'spiky',
    outfit: 'casual', shirtColor: 0xe9e6de, jeans: 0x3566a8, sneaker: 0xf0f0ee,
    heightScale: 1.0, buildScale: 1.0,
    mass: 1.0, attackPower: 1.0, moveAccel: 12,
    entrance: 'ready',
  },
};

export const CHARACTER_IDS = Object.keys(CHARACTERS);

// Region -> bone names. The engine uses these to drive per-region damage and tints.
export const REGION_BONES = {
  head: ['head'],
  torso: ['torso', 'hips'],
  arms: ['shoulderL', 'elbowL', 'shoulderR', 'elbowR'],
  legs: ['hipL', 'kneeL', 'hipR', 'kneeR'],
};

// Rounded boxes read as tailored cloth instead of voxels; the bevel also
// catches the rim light so limb silhouettes separate from the suit body.
function box(w, h, d, mat) {
  const r = Math.min(w, h, d) * 0.24;
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, r), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// Capsules for limbs — organic volumes instead of boxes.
function capsule(r, len, mat) {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 3, 10), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// Elliptical tapered cylinder for the torso masses.
function taper(rTop, rBottom, h, mat, zScale = 0.74) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, 14), mat);
  m.scale.z = zScale;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// Procedural suit-fabric weave: fine warp/weft lines + noise. Shared by all
// suits as both roughnessMap (sheen variation) and bumpMap (thread relief).
let _weaveTex = null;
function weaveTexture() {
  if (_weaveTex) return _weaveTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const img = g.createImageData(64, 64);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 4;
      const warp = (x % 4 < 2) ? 18 : 0;   // vertical threads
      const weft = (y % 4 < 2) ? 14 : 0;   // horizontal threads
      const noise = Math.floor(Math.random() * 36);
      const v = 165 + warp + weft + noise - 34;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  _weaveTex = new THREE.CanvasTexture(c);
  _weaveTex.wrapS = _weaveTex.wrapT = THREE.RepeatWrapping;
  _weaveTex.repeat.set(2, 2);
  return _weaveTex;
}

// Subtle pore/blotch noise for skin roughness.
let _skinTex = null;
function skinNoiseTexture() {
  if (_skinTex) return _skinTex;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const img = g.createImageData(32, 32);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 175 + Math.floor(Math.random() * 80);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  _skinTex = new THREE.CanvasTexture(c);
  _skinTex.wrapS = _skinTex.wrapT = THREE.RepeatWrapping;
  return _skinTex;
}

function sphere(r, mat) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), mat);
  m.castShadow = true;
  return m;
}

function buildHair(style, hairMat) {
  const g = new THREE.Group();
  if (style === 'sweep') {
    const top = box(0.3, 0.09, 0.3, hairMat);
    top.position.y = 0.335;
    const front = box(0.3, 0.07, 0.1, hairMat);
    front.position.set(0, 0.31, 0.17);
    g.add(top, front);
  } else if (style === 'comb') {
    const top = box(0.28, 0.06, 0.24, hairMat);
    top.position.set(0, 0.325, -0.03);
    g.add(top);
  } else if (style === 'balding') {
    // Bare crown; hair only above the ears and around the back.
    for (const s of [-1, 1]) {
      const side = box(0.05, 0.09, 0.2, hairMat);
      side.position.set(s * 0.135, 0.26, -0.02);
      g.add(side);
    }
    const back = box(0.28, 0.09, 0.05, hairMat);
    back.position.set(0, 0.26, -0.13);
    g.add(back);
  } else if (style === 'widow') {
    // Slicked top with a widow's-peak wedge pointing down the brow.
    const top = box(0.28, 0.07, 0.26, hairMat);
    top.position.set(0, 0.325, -0.02);
    const peak = box(0.09, 0.05, 0.06, hairMat);
    peak.position.set(0, 0.29, 0.135);
    peak.rotation.x = 0.3;
    g.add(top, peak);
  } else if (style === 'spiky') {
    // Messy tufts at varying angles — reads as "regular guy", not a statesman.
    const base = box(0.29, 0.07, 0.29, hairMat);
    base.position.y = 0.32;
    g.add(base);
    const tufts = [
      [-0.09, 0.365, 0.05, 0.3], [0.02, 0.375, -0.04, -0.25],
      [0.1, 0.36, 0.07, 0.4], [-0.02, 0.37, 0.1, -0.35], [0.06, 0.365, -0.1, 0.2],
    ];
    for (const [x, y, z, rz] of tufts) {
      const tuft = box(0.07, 0.09, 0.07, hairMat);
      tuft.position.set(x, y, z);
      tuft.rotation.z = rz;
      tuft.rotation.x = rz * -0.6;
      g.add(tuft);
    }
  } else {
    const top = box(0.28, 0.07, 0.28, hairMat);
    top.position.y = 0.325;
    const back = box(0.28, 0.1, 0.06, hairMat);
    back.position.set(0, 0.28, -0.13);
    g.add(top, back);
  }
  return g;
}

/**
 * Builds one fighter rig. Returns { root, joints, materials, config, baseColors }.
 */
export function buildFighter(charId) {
  const c = CHARACTERS[charId];
  const b = c.buildScale;
  const casual = c.outfit === 'casual';

  // For a casual outfit the "suit" material is the t-shirt (the engine's
  // sweat/tint systems talk to materials.suitMat, so the torso material must
  // keep that name regardless of wardrobe), and the legs get denim instead.
  const suitMat = new THREE.MeshStandardMaterial({
    color: casual ? c.shirtColor : c.suit,
    roughness: casual ? 0.9 : 0.95, metalness: casual ? 0.0 : 0.05,
    roughnessMap: weaveTexture(),
    bumpMap: weaveTexture(), bumpScale: casual ? 0.25 : 0.6,
  });
  const legMat = casual
    ? new THREE.MeshStandardMaterial({
        color: c.jeans, roughness: 0.98, metalness: 0.0,
        roughnessMap: weaveTexture(),
        bumpMap: weaveTexture(), bumpScale: 0.8,
      })
    : suitMat;
  const skinMat = new THREE.MeshStandardMaterial({
    color: c.skin, roughness: 0.55, metalness: 0.0,
    roughnessMap: skinNoiseTexture(),
  });
  const tieMat = new THREE.MeshStandardMaterial({
    color: c.tie ?? c.jeans ?? 0x444444, roughness: 0.5, metalness: 0.0,
    bumpMap: weaveTexture(), bumpScale: 0.3,
  });
  const hairMat = new THREE.MeshStandardMaterial({
    color: c.hair, roughness: 0.85, metalness: 0.0,
  });
  const shoeMat = new THREE.MeshStandardMaterial({
    color: casual ? c.sneaker : 0x111111,
    roughness: casual ? 0.7 : 0.35, metalness: 0.05,
  });
  const shirtMat = new THREE.MeshStandardMaterial({
    color: 0xf5f5f0, roughness: 0.85, metalness: 0.0,
  });

  const root = new THREE.Group();

  const hips = new THREE.Group();
  hips.position.y = 1.0;
  root.add(hips);

  // Organic torso: tapered elliptical masses instead of boxes — waist
  // narrower than shoulders, pelvis flaring slightly to the hips.
  const pelvis = taper(0.175 * b, 0.195 * b, 0.24, legMat, 0.78);
  hips.add(pelvis);

  const torso = new THREE.Group();
  torso.position.y = 0.1;
  hips.add(torso);

  const chest = taper(0.235 * b, 0.165 * b, 0.62, suitMat, 0.72);
  chest.position.y = 0.3;
  torso.add(chest);

  // Suit shoulders: rounded caps where the arms meet the jacket.
  for (const s of [-1, 1]) {
    const cap = sphere(0.085 * b, suitMat);
    cap.scale.set(1.15, 0.85, 1.0);
    cap.position.set(s * 0.26 * b, 0.5, 0);
    torso.add(cap);
  }

  // Neck bridging the collar to the head.
  const neck = capsule(0.055, 0.08, skinMat);
  neck.position.y = 0.6;
  torso.add(neck);

  // Suit-only dressing: dress-shirt panel, jacket buttons, and the tie.
  // A casual fighter (BOB) wears a plain tee — none of these apply.
  let tiePivot = null;
  if (!casual) {
    const shirt = box(0.16 * b, 0.46, 0.02, shirtMat);
    shirt.position.set(0, 0.34, 0.152 * b);
    torso.add(shirt);
    // Jacket buttons.
    for (const by of [0.16, 0.06]) {
      const btn = sphere(0.014, shoeMat);
      btn.position.set(0, by, 0.155 * b);
      torso.add(btn);
    }

    // Tie hangs from a pivot at the knot so secondary motion can swing it —
    // the jiggle solver (updateJiggles) drives tiePivot.rotation from the
    // torso's world acceleration each frame.
    const tieLen = 0.4 * c.tieLength;
    tiePivot = new THREE.Group();
    tiePivot.position.set(0, 0.52, 0.175 * b);
    const tie = box(0.07, tieLen, 0.02, tieMat);
    tie.position.set(0, -tieLen / 2, 0.005);
    tiePivot.add(tie);
    torso.add(tiePivot);
  } else {
    // Tee details: a ring collar and a small chest pocket print.
    const collar = taper(0.075, 0.085, 0.045, suitMat, 0.9);
    collar.position.y = 0.585;
    torso.add(collar);
    const pocket = box(0.06, 0.07, 0.015, new THREE.MeshStandardMaterial({
      color: 0xc9c4b8, roughness: 0.9,
    }));
    pocket.position.set(0.08 * b, 0.34, 0.15 * b);
    torso.add(pocket);
  }

  const head = new THREE.Group();
  head.position.y = 0.62;
  torso.add(head);

  const skull = box(0.26, 0.28, 0.26, skinMat);
  skull.position.y = 0.16;
  head.add(skull);
  // Hair on its own pivot so it can flop with a subtler jiggle than the tie.
  const hairPivot = new THREE.Group();
  hairPivot.position.y = 0.3;
  const hair = buildHair(c.hairStyle, hairMat);
  hair.position.y = -0.3;
  hairPivot.add(hair);
  head.add(hairPivot);

  const earR = c.id === 'bush' ? 0.05 : 0.035;
  for (const side of [-1, 1]) {
    const ear = sphere(earR, skinMat);
    ear.position.set(side * 0.14, 0.16, 0);
    head.add(ear);
  }

  // Cut decal above the brow — hidden until head damage passes the threshold
  // (the engine toggles refs.cut.visible).
  const cut = box(0.024, 0.06, 0.02, new THREE.MeshStandardMaterial({
    color: 0x7a1512, roughness: 0.35,
  }));
  cut.position.set(0.085, 0.225, 0.125);
  cut.rotation.z = 0.45;
  cut.visible = false;
  head.add(cut);

  if (c.aviators) {
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x14161a, roughness: 0.1, metalness: 0.85,
    });
    for (const side of [-1, 1]) {
      const lens = box(0.09, 0.07, 0.02, glassMat);
      lens.position.set(side * 0.065, 0.18, 0.14);
      head.add(lens);
    }
    const bridge = box(0.04, 0.015, 0.02, glassMat);
    bridge.position.set(0, 0.19, 0.14);
    head.add(bridge);
  }

  const joints = { hips, torso, head };

  for (const side of ['L', 'R']) {
    const s = side === 'L' ? -1 : 1;

    // Arms: capsule sleeves with a shirt cuff and a mitt-shaped hand.
    const shoulder = new THREE.Group();
    shoulder.position.set(s * 0.28 * b, 0.5, 0);
    torso.add(shoulder);
    const upperArm = capsule(0.058 * b, 0.2, suitMat);
    upperArm.position.y = -0.16;
    shoulder.add(upperArm);

    const elbow = new THREE.Group();
    elbow.position.y = -0.34;
    shoulder.add(elbow);
    // Casual = short tee sleeves: the forearm is bare skin with no cuff.
    const forearm = capsule(0.05 * b, 0.18, casual ? skinMat : suitMat);
    forearm.position.y = -0.13;
    elbow.add(forearm);
    if (!casual) {
      const cuff = capsule(0.052 * b, 0.02, shirtMat);
      cuff.position.y = -0.235;
      elbow.add(cuff);
    }
    const fist = sphere(0.075, skinMat);
    fist.scale.set(0.95, 0.8, 1.2);
    fist.position.y = -0.3;
    elbow.add(fist);

    // Legs: capsule trousers over dress shoes with a heel.
    const hip = new THREE.Group();
    hip.position.set(s * 0.11, -0.1, 0);
    hips.add(hip);
    const thigh = capsule(0.078 * b, 0.26, legMat);
    thigh.position.y = -0.2;
    hip.add(thigh);

    const knee = new THREE.Group();
    knee.position.y = -0.42;
    hip.add(knee);
    const shin = capsule(0.06 * b, 0.26, legMat);
    shin.position.y = -0.2;
    knee.add(shin);
    const shoe = box(0.115, 0.075, 0.26, shoeMat);
    shoe.position.set(0, -0.45, 0.06);
    knee.add(shoe);
    if (casual) {
      // Sneaker sole: a dark rubber slab under the white upper.
      const sole = box(0.12, 0.03, 0.28, new THREE.MeshStandardMaterial({
        color: 0x2c2c2c, roughness: 0.9,
      }));
      sole.position.set(0, -0.492, 0.05);
      knee.add(sole);
    } else {
      const heel = box(0.1, 0.05, 0.08, shoeMat);
      heel.position.set(0, -0.462, -0.05);
      knee.add(heel);
    }

    joints['shoulder' + side] = shoulder;
    joints['elbow' + side] = elbow;
    joints['hip' + side] = hip;
    joints['knee' + side] = knee;
    // Strike anchors: the actual fist/shoe meshes, registered as joints so
    // the hit capsules track the visible polygons instead of approximating
    // them with forward-reach offsets from the elbow/knee.
    joints['fist' + side] = fist;
    joints['foot' + side] = shoe;
  }

  root.scale.setScalar(c.heightScale);

  // Secondary-motion springs. `gain` converts world acceleration into swing,
  // `stiffness`/`damping` shape the pendulum. The tie is loose and floppy;
  // hair is stiff with a small max deflection.
  const jiggles = [
    { pivot: hairPivot, stiffness: 70, damping: 9, gain: 0.005, max: 0.28,
      rx: 0, rz: 0, vrx: 0, vrz: 0, prev: null, vel: new THREE.Vector3() },
  ];
  if (tiePivot) {
    jiggles.push({ pivot: tiePivot, stiffness: 42, damping: 7, gain: 0.014, max: 0.85,
      rx: 0, rz: 0, vrx: 0, vrz: 0, prev: null, vel: new THREE.Vector3() });
  }

  return {
    root,
    joints,
    jiggles,
    // Direct mesh handles for the damage-visuals system (swelling, cut).
    refs: { skull, cut, hairPivot },
    materials: { suitMat, skinMat, tieMat, hairMat },
    config: c,
    baseColors: {
      suit: new THREE.Color(casual ? c.shirtColor : c.suit),
      skin: new THREE.Color(c.skin),
      tie: new THREE.Color(c.tie ?? c.jeans ?? 0x444444),
    },
  };
}

// ── Secondary motion (tie/hair jiggle) ────────────────────────────────────
// Damped angular springs driven by the pivot's world-space acceleration:
// the appendage lags behind whatever the torso/head does — walking, punch
// twists, knockback — with no per-appendage special cases. Called from the
// engine's render loop at frame rate.
const _jw = new THREE.Vector3();
const _jv = new THREE.Vector3();
const _jaccel = new THREE.Vector3();
const _jq = new THREE.Quaternion();
export function updateJiggles(rig, dt) {
  if (!rig.jiggles) return;
  dt = Math.min(dt, 1 / 30);
  if (dt <= 1e-5) return;
  for (const j of rig.jiggles) {
    j.pivot.getWorldPosition(_jw);
    if (!j.prev) {
      j.prev = _jw.clone();
      continue;
    }
    _jv.copy(_jw).sub(j.prev).divideScalar(dt);
    _jaccel.copy(_jv).sub(j.vel).divideScalar(dt);
    j.vel.copy(_jv);
    j.prev.copy(_jw);

    // Clamp accel spikes (teleports, replay scrubs) so the spring can't blow up.
    const m = _jaccel.length();
    if (m > 80) _jaccel.multiplyScalar(80 / m);

    // World accel → parent-local: the swing must be relative to the torso/head.
    j.pivot.parent.getWorldQuaternion(_jq);
    _jaccel.applyQuaternion(_jq.invert());

    // Lag: forward accel (+Z local) tips the appendage backward (+rot.x);
    // lateral accel (+X) tips it the other way (−rot.z).
    j.vrx += (_jaccel.z * j.gain - j.rx * j.stiffness - j.vrx * j.damping) * dt;
    j.vrz += (-_jaccel.x * j.gain - j.rz * j.stiffness - j.vrz * j.damping) * dt;
    j.rx = Math.max(-j.max, Math.min(j.max, j.rx + j.vrx * dt));
    j.rz = Math.max(-j.max, Math.min(j.max, j.rz + j.vrz * dt));
    j.pivot.rotation.x = j.rx;
    j.pivot.rotation.z = j.rz;
  }
}

// Per-region bruise tinting used to live here (tintJoint/resetTints). Removed
// per user request: a fighter's model colors never change when hit or KO'd —
// damage is communicated via the HUD body diagram instead.