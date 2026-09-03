// terrainMesh.js — the island as one vertex-coloured mesh plus a water plane.
//
// Colours come from the biome and the live grass biomass, so grazing, fire and lava show
// up without rebuilding geometry: only the colour attribute is rewritten (per tile-sync).
import * as THREE from 'three';
import { TILE, TILE_STATE, tileX, tileZ } from '../sim/terrain/tiles.js';

// Base colours per tile type (linear-ish sRGB hex, picked to read at a distance).
const BIOME = {
  [TILE.OCEAN]: 0x0c4a6e, [TILE.BEACH]: 0xd8c48f, [TILE.GRASS]: 0x4e7f2f, [TILE.FOREST]: 0x1f5c2a,
  [TILE.HILL]: 0x6b7a4a, [TILE.MOUNTAIN]: 0x7a736b, [TILE.LAKE]: 0x0ea5e9, [TILE.VOLCANO]: 0x44403c,
};
const STATE_COLOUR = {
  [TILE_STATE.FIRE]: 0xf97316, [TILE_STATE.BURNT]: 0x2a2724, [TILE_STATE.LAVA]: 0xef4444,
  [TILE_STATE.COOLED]: 0x3f3a36, [TILE_STATE.BOULDER]: 0x8a8378,
};
const DRY = new THREE.Color(0x8a7f4a);   // grass at zero biomass

export function createTerrainMesh(terrain) {
  const { size, height } = terrain;
  const cs = size + 1;
  const geometry = new THREE.PlaneGeometry(size, size, size, size);
  geometry.rotateX(-Math.PI / 2);
  const pos = geometry.attributes.position;
  // PlaneGeometry rows run +x then -z; translate so tile (0,0) sits at world (0,0).
  for (let j = 0; j < cs; j++) {
    for (let i = 0; i < cs; i++) {
      const v = j * cs + i;
      pos.setX(v, i);
      pos.setZ(v, j);
      pos.setY(v, height[j * cs + i]);
    }
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cs * cs * 3), 3));

  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.name = 'island';

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(size * 3, size * 3),
    new THREE.MeshLambertMaterial({ color: 0x0e7490, transparent: true, opacity: 0.75 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(size / 2, 0, size / 2);
  water.name = 'water';

  const colour = new THREE.Color();

  /** Recolour every vertex from the tile type, its state and the grass biomass (0..255). */
  function paint(tileState, grass) {
    const colours = geometry.attributes.color;
    for (let j = 0; j < cs; j++) {
      for (let i = 0; i < cs; i++) {
        // A corner takes the colour of the tile down-right of it (clamped at the edges).
        const t = Math.min(size - 1, i) + Math.min(size - 1, j) * size;
        const stateColour = STATE_COLOUR[tileState?.[t] ?? 0];
        if (stateColour !== undefined) colour.setHex(stateColour);
        else {
          colour.setHex(BIOME[terrain.type[t]] ?? 0x555555);
          // lerp does not mutate its argument, so the constant can be passed directly.
          if (grass && (terrain.type[t] === TILE.GRASS || terrain.type[t] === TILE.HILL)) colour.lerp(DRY, 1 - grass[t] / 255);
        }
        colours.setXYZ(j * cs + i, colour.r, colour.g, colour.b);
      }
    }
    colours.needsUpdate = true;
  }
  paint(null, null);

  return {
    mesh, water, paint,
    dispose() { geometry.dispose(); material.dispose(); water.geometry.dispose(); water.material.dispose(); },
    tileAt: (x, z) => Math.min(size - 1, Math.max(0, x | 0)) + Math.min(size - 1, Math.max(0, z | 0)) * size,
    tileX: (i) => tileX(i, size), tileZ: (i) => tileZ(i, size),
  };
}
