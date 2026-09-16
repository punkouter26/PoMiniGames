// creatureMeshes.js — creatures as low-poly primitive assemblies, one InstancedMesh per
// (species × body part). Every creature is drawn from the frame's [x, y, z, yaw, scale,
// species, goal, lifeStage] record; legs swing cosmetically from the position delta, so
// walking reads as walking without the sim sending any animation state.
import * as THREE from 'three';
import { FRAME } from '../sim/frame.js';
import { SPECIES_ID } from '../sim/creatures/species.js';
import { enhanceLambert } from './materials.js';

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

// The evolution tint: a creature's chosen base trait mapped cool → warm. Applied through
// InstancedMesh.instanceColor, which multiplies the material colour, so the species
// material goes white while a tint is on and back to its own colour when it is off.
const TINT_LOW = new THREE.Color(0x2563eb);
const TINT_HIGH = new THREE.Color(0xfbbf24);

export function createCreatureMeshes(scene, cap) {
  const groups = [];
  let tint = -1;               // trait index, -1 for none
  let repaint = false;         // one pass back to white after the tint is switched off
  const tintColour = new THREE.Color();
  // Two reusable transforms: at 400 creatures × ~8 parts × 60 fps, allocating an
  // Object3D per part per frame would be ~200k allocations a second.
  const dummy = new THREE.Object3D();
  const local = new THREE.Object3D();
  for (const [id, rig] of Object.entries(RIGS)) {
    // Fur/skin grain at a body scale, and a sky-tinted rim so a creature separates from the
    // ground it stands on at a distance (materials.js).
    const material = enhanceLambert(new THREE.MeshLambertMaterial({ color: rig.colour, flatShading: true }), { rim: 0.42, mottle: 0.16, mottleScale: 0.9 });
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

  // There is no selection outline. A cyan wireframe box used to track the inspected
  // creature — and, because the auto-director inspected whatever it was filming, it sat
  // around the subject of every cinematic shot. Removed 2026-09-16 at the user's request:
  // the shot itself says what is being watched, and the popover names it.

  return {
    /** Colour every creature by one base trait (0–4), or -1 to restore species colours. */
    setTint(traitIndex) {
      const next = Number.isInteger(traitIndex) && traitIndex >= 0 && traitIndex < 5 ? traitIndex : -1;
      if (next === tint) return;
      tint = next;
      repaint = true;
      for (const g of groups) if (g) g.material.color.setHex(tint >= 0 ? 0xffffff : g.rig.colour);
    },
    get tint() { return tint; },
    /**
     * Draw one frame. `view` is the interpolated creature array, `count` how many are live,
     * `time` seconds for the leg swing.
     */
    draw(view, count, time, speeds) {
      for (const g of groups) if (g) g.count = 0;
      const paint = tint >= 0 || repaint;
      for (let k = 0; k < count; k++) {
        const o = k * FRAME.CREATURE_STRIDE;
        const species = view[o + 5] | 0;
        const g = groups[species];
        if (!g) continue;
        const scale = g.rig.scale * (view[o + 7] === 0 ? JUVENILE_SCALE : 1) * (view[o + 4] || 1);
        const swing = Math.sin(time * 9 + k) * Math.min(0.5, (speeds?.[k] ?? 0) * 0.12);
        const i = g.count++;
        if (paint) {
          if (tint >= 0) tintColour.copy(TINT_LOW).lerp(TINT_HIGH, Math.max(0, Math.min(1, view[o + FRAME.TRAIT_OFFSET + tint])));
          else tintColour.setRGB(1, 1, 1);
          for (const part of g.parts) part.mesh.setColorAt(i, tintColour);
        }
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
      }
      for (const g of groups) {
        if (!g) continue;
        for (const part of g.parts) {
          part.mesh.count = g.count; part.mesh.instanceMatrix.needsUpdate = true;
          if (paint && part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
        }
      }
      if (tint < 0) repaint = false;
    },
    dispose() {
      for (const g of groups) {
        if (!g) continue;
        for (const part of g.parts) { scene.remove(part.mesh); part.geo.dispose(); part.mesh.dispose(); }
        g.material.dispose();
      }
    },
  };
}
