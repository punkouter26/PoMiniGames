// fighters.js — the four president caricatures as hierarchical three.js primitive rigs.
// Silhouette identity comes from hair geometry, suit/tie palette and height/build scale;
// faces stay abstract so the caricature reads as playful, not mocking.
import * as THREE from 'three';

export const CHARACTERS = {
  trump: {
    id: 'trump', name: 'Trump',
    skin: 0xf0b98a, suit: 0x1b2a52, tie: 0xd62828, tieLength: 1.4,
    hair: 0xf5d47a, hairStyle: 'sweep',
    heightScale: 1.02, buildScale: 1.15,
  },
  biden: {
    id: 'biden', name: 'Biden',
    skin: 0xe8bfa4, suit: 0x24365e, tie: 0x7fb2e5, tieLength: 1.0,
    hair: 0xf2f2f2, hairStyle: 'comb',
    heightScale: 1.0, buildScale: 0.95, aviators: true,
  },
  obama: {
    id: 'obama', name: 'Obama',
    skin: 0x8d5524, suit: 0x3a3f44, tie: 0x2456c9, tieLength: 1.0,
    hair: 0x2b2b2b, hairStyle: 'cap',
    heightScale: 1.04, buildScale: 0.95,
  },
  bush: {
    id: 'bush', name: 'Bush',
    skin: 0xe3b18e, suit: 0x17181c, tie: 0xb02323, tieLength: 0.85,
    hair: 0x8a8073, hairStyle: 'cap',
    heightScale: 0.97, buildScale: 1.08,
  },
};

export const CHARACTER_IDS = Object.keys(CHARACTERS);

function box(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true;
  return m;
}

function sphere(r, mat) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), mat);
  m.castShadow = true;
  return m;
}

function buildHair(style, hairMat, skinMat) {
  const g = new THREE.Group();
  if (style === 'sweep') {
    // Flattened swept slab with a front overhang wedge.
    const top = box(0.3, 0.09, 0.3, hairMat);
    top.position.y = 0.335;
    const front = box(0.3, 0.07, 0.1, hairMat);
    front.position.set(0, 0.31, 0.17);
    g.add(top, front);
  } else if (style === 'comb') {
    // Thin combed-back cap, receded at the front.
    const top = box(0.28, 0.06, 0.24, hairMat);
    top.position.set(0, 0.325, -0.03);
    g.add(top);
  } else {
    // Short close cap.
    const top = box(0.28, 0.07, 0.28, hairMat);
    top.position.y = 0.325;
    const back = box(0.28, 0.1, 0.06, hairMat);
    back.position.set(0, 0.28, -0.13);
    g.add(top, back);
  }
  return g;
}

/**
 * Builds one fighter rig. Returns { root, joints, materials, config } where joints are the
 * named THREE.Group pivots the animator drives: hips, torso, head, shoulderL/R, elbowL/R,
 * hipL/R, kneeL/R. The rig faces local +Z; the game yaws `root` toward the opponent.
 */
export function buildFighter(charId) {
  const c = CHARACTERS[charId];
  const b = c.buildScale;

  const suitMat = new THREE.MeshLambertMaterial({ color: c.suit });
  const skinMat = new THREE.MeshLambertMaterial({ color: c.skin });
  const tieMat = new THREE.MeshLambertMaterial({ color: c.tie });
  const hairMat = new THREE.MeshLambertMaterial({ color: c.hair });
  const shoeMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
  const shirtMat = new THREE.MeshLambertMaterial({ color: 0xf5f5f0 });

  const root = new THREE.Group();

  const hips = new THREE.Group();
  hips.position.y = 1.0;
  root.add(hips);

  const pelvis = box(0.36 * b, 0.2, 0.26, suitMat);
  hips.add(pelvis);

  const torso = new THREE.Group();
  torso.position.y = 0.1;
  hips.add(torso);

  const chest = box(0.44 * b, 0.6, 0.3, suitMat);
  chest.position.y = 0.3;
  torso.add(chest);

  const shirt = box(0.16 * b, 0.5, 0.02, shirtMat);
  shirt.position.set(0, 0.32, 0.155);
  torso.add(shirt);

  const tieLen = 0.4 * c.tieLength;
  const tie = box(0.07, tieLen, 0.02, tieMat);
  tie.position.set(0, 0.52 - tieLen / 2, 0.17);
  torso.add(tie);

  const head = new THREE.Group();
  head.position.y = 0.62;
  torso.add(head);

  const skull = box(0.26, 0.28, 0.26, skinMat);
  skull.position.y = 0.16;
  head.add(skull);
  head.add(buildHair(c.hairStyle, hairMat, skinMat));

  // Ears — slightly oversized for Bush per the caricature spec.
  const earR = c.id === 'bush' ? 0.05 : 0.035;
  for (const side of [-1, 1]) {
    const ear = sphere(earR, skinMat);
    ear.position.set(side * 0.14, 0.16, 0);
    head.add(ear);
  }

  if (c.aviators) {
    const glassMat = new THREE.MeshLambertMaterial({ color: 0x14161a });
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

    const shoulder = new THREE.Group();
    shoulder.position.set(s * 0.28 * b, 0.5, 0);
    torso.add(shoulder);
    const upperArm = box(0.11, 0.3, 0.11, suitMat);
    upperArm.position.y = -0.16;
    shoulder.add(upperArm);

    const elbow = new THREE.Group();
    elbow.position.y = -0.34;
    shoulder.add(elbow);
    const forearm = box(0.1, 0.28, 0.1, suitMat);
    forearm.position.y = -0.14;
    elbow.add(forearm);
    const fist = sphere(0.085, skinMat);
    fist.position.y = -0.31;
    elbow.add(fist);

    const hip = new THREE.Group();
    hip.position.set(s * 0.11, -0.1, 0);
    hips.add(hip);
    const thigh = box(0.13, 0.4, 0.14, suitMat);
    thigh.position.y = -0.2;
    hip.add(thigh);

    const knee = new THREE.Group();
    knee.position.y = -0.42;
    hip.add(knee);
    const shin = box(0.11, 0.4, 0.12, suitMat);
    shin.position.y = -0.2;
    knee.add(shin);
    const shoe = box(0.12, 0.09, 0.24, shoeMat);
    shoe.position.set(0, -0.44, 0.05);
    knee.add(shoe);

    joints['shoulder' + side] = shoulder;
    joints['elbow' + side] = elbow;
    joints['hip' + side] = hip;
    joints['knee' + side] = knee;
  }

  root.scale.setScalar(c.heightScale);

  return { root, joints, materials: { suitMat, skinMat, tieMat, hairMat }, config: c };
}
