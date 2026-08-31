// PoGallery chair model entry point.
//
// Adapts the img2threejs-generated factory (createObjectModel.js) to the harness
// contract: a default export taking ({ scene, THREE, camera, renderer }).
//
// The factory's own createSculptMaterial produces near-black results in this
// environment because it loads PBR maps cross-origin (no CORS header on static
// files) or from host paths the harness cannot reach. For a reliable, correct-colored
// demo we override every material with a plain MeshStandardMaterial matching the
// reference palette:
//   - upholstery: deep navy, matte cloth
//   - frame: light grey, brushed metal (metalness 0.85, roughness 0.4)
//   - glides: near-black matte rubber
// The factory's materials are identified by material.userData.sculptMaterial.id.
//
// We also apply the factory's RoomEnvironment to the renderer so the metal frame
// has something to reflect (no HDRI asset, deterministic).

import * as THREE from "three";
import {
  createNavyUpholsteredChairModel,
  createNavyUpholsteredChairEnvironment,
} from "./createObjectModel.js";

const PALETTE = {
  upholstery: { color: 0x1c2c52, roughness: 0.85, metalness: 0.0 },
  frame: { color: 0xb8b8b8, roughness: 0.40, metalness: 0.85 },
  glides: { color: 0x1a1a1a, roughness: 0.90, metalness: 0.0 },
};

function overrideMaterials(group) {
  gridReplace: {
    const used = new Set();
    group.traverse((obj) => {
      if (!obj.isMesh) return;
      const id = obj.material?.userData?.sculptMaterial?.id;
      if (id && PALETTE[id] && !used.has(id)) {
        // One shared material instance per material id.
        const p = PALETTE[id];
        const mat = new THREE.MeshStandardMaterial({
          color: p.color,
          roughness: p.roughness,
          metalness: p.metalness,
        });
        mat.userData.sculptMaterialId = id;
        used.add(id);
      }
    });
    // Second pass: assign the shared instance to every mesh that uses that id.
    const byId = {};
    group.traverse((obj) => {
      if (!obj.isMesh) return;
      const id = obj.material?.userData?.sculptMaterial?.id;
      if (id && PALETTE[id]) {
        if (!byId[id]) {
          const p = PALETTE[id];
          byId[id] = new THREE.MeshStandardMaterial({
            color: p.color,
            roughness: p.roughness,
            metalness: p.metalness,
          });
          byId[id].userData.sculptMaterialId = id;
        }
        obj.material = byId[id];
      }
    });
  }
}

export default async function chairModelFactory({ scene, renderer }) {
  const group = createNavyUpholsteredChairModel({
    wireframe: false,
    castShadow: true,
    receiveShadow: true,
  });
  // The spec's `root` component is a bounding container, not visible geometry — the
  // generator emits a mesh for it, so hide it to reveal the chair parts.
  const rootMesh = group.getObjectByName("root");
  if (rootMesh) rootMesh.visible = false;

  overrideMaterials(group);

  // Give the metal frame an environment to reflect (deterministic, no HDRI file).
  try {
    const env = createNavyUpholsteredChairEnvironment(renderer);
    scene.environment = env;
  } catch (e) {
    // Environment is best-effort; the demo still renders with plain lights.
  }

  scene.add(group);
  return group;
}

export { createNavyUpholsteredChairModel };
