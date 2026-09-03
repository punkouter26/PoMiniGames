// floraMeshes.js — trees, stumps, berry bushes, huts and fire/lava markers. All static
// per tile-sync (once a second), so each is one InstancedMesh rebuilt only when the tile
// message says something changed.
import * as THREE from 'three';
import { TILE_STATE, tileX, tileZ } from '../sim/terrain/tiles.js';
import { TREE_STATE } from '../sim/flora/trees.js';

function instanced(scene, geo, colour, cap, name, { emissive = 0 } = {}) {
  const material = new THREE.MeshLambertMaterial({ color: colour, flatShading: true, emissive });
  const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, cap));
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = true; mesh.count = 0; mesh.frustumCulled = false; mesh.name = name;
  scene.add(mesh);
  return { mesh, geo, material };
}

export function createFloraMeshes(scene, terrain, { trees = [], bushes = [] } = {}) {
  const size = terrain.size;
  const treeCap = Math.max(1, trees.length);
  const bushCap = Math.max(1, bushes.length);
  const trunk = instanced(scene, new THREE.CylinderGeometry(0.18, 0.24, 2.6, 5), 0x6b4423, treeCap, 'tree-trunk');
  const crown = instanced(scene, new THREE.ConeGeometry(1.5, 3.2, 6), 0x1f5c2a, treeCap, 'tree-crown');
  const stump = instanced(scene, new THREE.CylinderGeometry(0.26, 0.3, 0.5, 5), 0x4a3520, treeCap, 'tree-stump');
  const bush = instanced(scene, new THREE.IcosahedronGeometry(0.55, 0), 0x2f6b34, bushCap, 'bush');
  const berry = instanced(scene, new THREE.IcosahedronGeometry(0.6, 0), 0x9f1239, bushCap, 'bush-ripe');
  const hutBase = instanced(scene, new THREE.BoxGeometry(2.2, 1.6, 2.2), 0xa8a29e, 32, 'hut');
  const hutRoof = instanced(scene, new THREE.ConeGeometry(1.9, 1.4, 4), 0x7c2d12, 32, 'hut-roof');
  const flame = instanced(scene, new THREE.ConeGeometry(0.5, 1.4, 5), 0xf97316, 4096, 'fire', { emissive: 0xf97316 });
  const lava = instanced(scene, new THREE.BoxGeometry(1, 0.3, 1), 0xef4444, 512, 'lava', { emissive: 0x991b1b });
  const carcass = instanced(scene, new THREE.BoxGeometry(0.7, 0.3, 1.0), 0x57534e, 256, 'carcass');
  const all = [trunk, crown, stump, bush, berry, hutBase, hutRoof, flame, lava, carcass];
  const dummy = new THREE.Object3D();

  const place = (entry, i, x, y, z, scale = 1, rotY = 0) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rotY, 0);
    dummy.scale.set(scale, scale, scale);
    dummy.updateMatrix();
    entry.mesh.setMatrixAt(i, dummy.matrix);
  };
  const centre = (tile) => [tileX(tile, size) + 0.5, tileZ(tile, size) + 0.5];

  return {
    /** msg: the runtime's `tiles` message (tileState, treeState, bushRipe, huts, carcasses). */
    update(msg, time = 0) {
      let nTrunk = 0; let nStump = 0;
      for (let k = 0; k < trees.length; k++) {
        const [x, z] = centre(trees[k]);
        const y = terrain.heightAt(x, z);
        if ((msg.treeState?.[k] ?? TREE_STATE.STANDING) === TREE_STATE.STANDING) {
          place(trunk, nTrunk, x, y + 1.3, z, 1, (k % 7) * 0.4);
          place(crown, nTrunk, x, y + 3.4, z, 0.85 + (k % 5) * 0.06, (k % 7) * 0.4);
          nTrunk++;
        } else { place(stump, nStump++, x, y + 0.25, z); }
      }
      trunk.mesh.count = nTrunk; crown.mesh.count = nTrunk; stump.mesh.count = nStump;

      let nBush = 0; let nBerry = 0;
      for (let k = 0; k < bushes.length; k++) {
        const [x, z] = centre(bushes[k]);
        const y = terrain.heightAt(x, z);
        if ((msg.bushRipe?.[k] ?? 0) >= 128) place(berry, nBerry++, x, y + 0.5, z);
        else place(bush, nBush++, x, y + 0.45, z);
      }
      bush.mesh.count = nBush; berry.mesh.count = nBerry;

      const huts = msg.huts ?? [];
      huts.forEach((h, k) => {
        const y = terrain.heightAt(h.x, h.z);
        place(hutBase, k, h.x, y + 0.8, h.z, 1, (k % 4) * 0.3);
        place(hutRoof, k, h.x, y + 2.2, h.z, 1, Math.PI / 4);
      });
      hutBase.mesh.count = huts.length; hutRoof.mesh.count = huts.length;

      let nFlame = 0; let nLava = 0;
      const state = msg.tileState;
      if (state) {
        for (let t = 0; t < state.length; t++) {
          if (state[t] === TILE_STATE.FIRE && nFlame < 4096) {
            const [x, z] = centre(t);
            place(flame, nFlame++, x, terrain.heightAt(x, z) + 0.7 + Math.sin(time * 6 + t) * 0.15, z, 0.8 + Math.sin(time * 8 + t) * 0.2);
          } else if (state[t] === TILE_STATE.LAVA && nLava < 512) {
            const [x, z] = centre(t);
            place(lava, nLava++, x, terrain.heightAt(x, z) + 0.15, z);
          }
        }
      }
      flame.mesh.count = nFlame; lava.mesh.count = nLava;

      const carcasses = msg.carcasses ?? [];
      carcasses.slice(0, 256).forEach((c, k) => place(carcass, k, c.x, terrain.heightAt(c.x, c.z) + 0.15, c.z, 0.6 + c.species * 0.2));
      carcass.mesh.count = Math.min(256, carcasses.length);

      for (const entry of all) entry.mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      for (const entry of all) { scene.remove(entry.mesh); entry.geo.dispose(); entry.mesh.dispose(); entry.material.dispose(); }
    },
  };
}
