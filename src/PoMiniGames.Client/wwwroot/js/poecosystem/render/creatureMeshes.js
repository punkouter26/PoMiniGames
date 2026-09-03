// creatureMeshes.js — creatures as low-poly primitive assemblies, one InstancedMesh per
// (species × body part). Every creature is drawn from the frame's [x, y, z, yaw, scale,
// species, goal, lifeStage] record; legs swing cosmetically from the position delta, so
// walking reads as walking without the sim sending any animation state.
import * as THREE from 'three';
import { FRAME } from '../sim/frame.js';
import { SPECIES_ID } from '../sim/creatures/species.js';

// Part = box or cone offset from the creature's origin (feet), forward = +Z.
const RIGS = {
  [SPECIES_ID.RABBIT]: {
    colour: 0xd9c8a9, scale: 0.5,
    parts: [
      { shape: 'box', size: [0.5, 0.3, 0.8], at: [0, 0.55, 0] },
      { shape: 'box', size: [0.3, 0.3, 0.3], at: [0, 0.75, 0.55] },
      { shape: 'cone', size: [0.07, 0.35], at: [-0.09, 1.0, 0.55] },
      { shape: 'cone', size: [0.07, 0.35], at: [0.09, 1.0, 0.55] },
      { shape: 'box', size: [0.12, 0.4, 0.12], at: [-0.18, 0.2, 0.3], leg: 1 },
      { shape: 'box', size: [0.12, 0.4, 0.12], at: [0.18, 0.2, 0.3], leg: -1 },
      { shape: 'box', size: [0.12, 0.4, 0.12], at: [-0.18, 0.2, -0.3], leg: -1 },
      { shape: 'box', size: [0.12, 0.4, 0.12], at: [0.18, 0.2, -0.3], leg: 1 },
    ],
  },
  [SPECIES_ID.DEER]: {
    colour: 0x9a6b3f, scale: 1.25,
    parts: [
      { shape: 'box', size: [0.5, 0.35, 0.9], at: [0, 0.62, 0] },
      { shape: 'box', size: [0.28, 0.28, 0.32], at: [0, 0.95, 0.55] },
      { shape: 'box', size: [0.16, 0.35, 0.16], at: [0, 0.85, 0.4] },
      { shape: 'cone', size: [0.05, 0.4], at: [-0.1, 1.2, 0.5] },
      { shape: 'cone', size: [0.05, 0.4], at: [0.1, 1.2, 0.5] },
      { shape: 'box', size: [0.12, 0.5, 0.12], at: [-0.2, 0.25, 0.32], leg: 1 },
      { shape: 'box', size: [0.12, 0.5, 0.12], at: [0.2, 0.25, 0.32], leg: -1 },
      { shape: 'box', size: [0.12, 0.5, 0.12], at: [-0.2, 0.25, -0.32], leg: -1 },
      { shape: 'box', size: [0.12, 0.5, 0.12], at: [0.2, 0.25, -0.32], leg: 1 },
    ],
  },
  [SPECIES_ID.WOLF]: {
    colour: 0x6b7280, scale: 1.0,
    parts: [
      { shape: 'box', size: [0.45, 0.35, 1.0], at: [0, 0.6, 0] },
      { shape: 'box', size: [0.3, 0.28, 0.4], at: [0, 0.68, 0.62] },
      { shape: 'cone', size: [0.06, 0.2], at: [-0.09, 0.86, 0.6] },
      { shape: 'cone', size: [0.06, 0.2], at: [0.09, 0.86, 0.6] },
      { shape: 'box', size: [0.12, 0.12, 0.5], at: [0, 0.62, -0.6] },
      { shape: 'box', size: [0.13, 0.5, 0.13], at: [-0.18, 0.25, 0.35], leg: 1 },
      { shape: 'box', size: [0.13, 0.5, 0.13], at: [0.18, 0.25, 0.35], leg: -1 },
      { shape: 'box', size: [0.13, 0.5, 0.13], at: [-0.18, 0.25, -0.35], leg: -1 },
      { shape: 'box', size: [0.13, 0.5, 0.13], at: [0.18, 0.25, -0.35], leg: 1 },
    ],
  },
  [SPECIES_ID.HUMAN]: {
    colour: 0xc7d2fe, scale: 1.0,
    parts: [
      { shape: 'box', size: [0.36, 0.24, 0.26], at: [0, 1.0, 0] },
      { shape: 'box', size: [0.4, 0.5, 0.28], at: [0, 1.4, 0] },
      { shape: 'box', size: [0.26, 0.26, 0.26], at: [0, 1.85, 0] },
      { shape: 'box', size: [0.12, 0.6, 0.12], at: [-0.3, 1.35, 0], leg: 1 },
      { shape: 'box', size: [0.12, 0.6, 0.12], at: [0.3, 1.35, 0], leg: -1 },
      { shape: 'box', size: [0.14, 0.9, 0.14], at: [-0.12, 0.45, 0], leg: -1 },
      { shape: 'box', size: [0.14, 0.9, 0.14], at: [0.12, 0.45, 0], leg: 1 },
    ],
  },
};

const JUVENILE_SCALE = 0.55;

export function createCreatureMeshes(scene, cap) {
  const groups = [];
  // Two reusable transforms: at 400 creatures × ~8 parts × 60 fps, allocating an
  // Object3D per part per frame would be ~200k allocations a second.
  const dummy = new THREE.Object3D();
  const local = new THREE.Object3D();
  const colour = new THREE.Color();
  for (const [id, rig] of Object.entries(RIGS)) {
    const material = new THREE.MeshLambertMaterial({ color: rig.colour, flatShading: true });
    const parts = rig.parts.map((p) => {
      const geo = p.shape === 'cone'
        ? new THREE.ConeGeometry(p.size[0], p.size[1], 5)
        : new THREE.BoxGeometry(p.size[0], p.size[1], p.size[2]);
      const mesh = new THREE.InstancedMesh(geo, material, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.name = `creature-${id}-${p.shape}`;
      scene.add(mesh);
      return { def: p, mesh, geo };
    });
    groups[Number(id)] = { rig, parts, material, count: 0 };
  }

  // Outline for the inspected creature: a wireframe box that follows it.
  const outline = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0x22d3ee, wireframe: true, transparent: true, opacity: 0.9 }),
  );
  outline.visible = false;
  outline.name = 'selection';
  scene.add(outline);

  return {
    outline,
    /**
     * Draw one frame. `view` is the interpolated creature array, `count` how many are live,
     * `selectedIndex` the row to outline (-1 for none), `time` seconds for the leg swing.
     */
    draw(view, count, selectedIndex, time, speeds) {
      for (const g of groups) if (g) g.count = 0;
      for (let k = 0; k < count; k++) {
        const o = k * FRAME.CREATURE_STRIDE;
        const species = view[o + 5] | 0;
        const g = groups[species];
        if (!g) continue;
        const scale = g.rig.scale * (view[o + 7] === 0 ? JUVENILE_SCALE : 1) * (view[o + 4] || 1);
        const swing = Math.sin(time * 9 + k) * Math.min(0.5, (speeds?.[k] ?? 0) * 0.12);
        const i = g.count++;
        for (const part of g.parts) {
          const { at, leg } = part.def;
          dummy.position.set(view[o], view[o + 1], view[o + 2]);
          dummy.rotation.set(0, view[o + 3], 0);
          dummy.scale.set(scale, scale, scale);
          dummy.updateMatrix();
          local.position.set(at[0], at[1], at[2] + (leg ? Math.sin(swing) * leg * 0.25 : 0));
          local.rotation.x = leg ? swing * leg : 0;
          local.updateMatrix();
          local.matrix.premultiply(dummy.matrix);
          part.mesh.setMatrixAt(i, local.matrix);
        }
        if (k === selectedIndex) {
          outline.visible = true;
          outline.position.set(view[o], view[o + 1] + scale * 0.9, view[o + 2]);
          outline.scale.set(scale * 1.4, scale * 1.9, scale * 1.9);
          outline.rotation.set(0, view[o + 3], 0);
          colour.setHex(0x22d3ee);
          outline.material.color.copy(colour);
        }
      }
      if (selectedIndex < 0) outline.visible = false;
      for (const g of groups) {
        if (!g) continue;
        for (const part of g.parts) { part.mesh.count = g.count; part.mesh.instanceMatrix.needsUpdate = true; }
      }
    },
    dispose() {
      for (const g of groups) {
        if (!g) continue;
        for (const part of g.parts) { scene.remove(part.mesh); part.geo.dispose(); part.mesh.dispose(); }
        g.material.dispose();
      }
      scene.remove(outline); outline.geometry.dispose(); outline.material.dispose();
    },
  };
}
