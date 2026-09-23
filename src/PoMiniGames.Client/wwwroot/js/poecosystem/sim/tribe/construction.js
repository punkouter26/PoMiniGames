// construction.js — building site selection, resource accumulation & structure lifecycles.
'use strict';

import { BUILDING_KIND, BUILDING_SPECS } from './contracts.js';
import { TILE, TILE_STATE, isWater, tileIndex, tileX, tileZ } from '../terrain/tiles.js';

export function createConstructionManager() {
  const buildings = []; // Array of active structures across all tribes
  // Per world, not per module: a module-level counter kept counting across every world the
  // tab ever built, and was never saved, so ids depended on how many islands came before.
  let nextBuildingId = 1;

  return {
    buildings,
    get nextId() { return nextBuildingId; },
    set nextId(v) { if (Number.isInteger(v) && v > 0) nextBuildingId = v; },

    findBuildSite(terrain, tileState, tribe, kind, rng) {
      const { size, type } = terrain;
      const spec = BUILDING_SPECS[kind];
      const r = Math.round(spec.footprintRadius + 3);
      const cx = Math.round(tribe.centerX);
      const cz = Math.round(tribe.centerZ);

      const candidates = [];

      for (let dz = -r * 2; dz <= r * 2; dz++) {
        for (let dx = -r * 2; dx <= r * 2; dx++) {
          const distSq = dx * dx + dz * dz;
          if (distSq < (r * r) || distSq > (r * 3) ** 2) continue;

          const tx = cx + dx;
          const tz = cz + dz;
          if (tx < 3 || tz < 3 || tx >= size - 3 || tz >= size - 3) continue;

          const t = tileIndex(tx, tz, size);
          if (type[t] !== TILE.GRASS || tileState[t] !== TILE_STATE.NORMAL) continue;

          // Check water proximity
          let nearWater = false;
          for (let wz = -1; wz <= 1 && !nearWater; wz++) {
            for (let wx = -1; wx <= 1; wx++) {
              if (isWater(type[tileIndex(tx + wx, tz + wz, size)])) {
                nearWater = true;
                break;
              }
            }
          }
          if (nearWater) continue;

          // Check distance from existing buildings
          let tooClose = false;
          for (const b of buildings) {
            if (Math.hypot(tx - b.x, tz - b.z) < spec.footprintRadius * 2.5) {
              tooClose = true;
              break;
            }
          }
          if (!tooClose) candidates.push(t);
        }
      }

      if (candidates.length === 0) return null;
      const rVal = rng.next ? rng.next() : (rng.uniform ? rng.uniform() : Math.random());
      const idx = Math.floor(rVal * candidates.length);
      return candidates[idx];
    },

    createBuilding(tribe, kind, tile, terrain) {
      const spec = BUILDING_SPECS[kind];
      const b = {
        id: nextBuildingId++,
        tribeId: tribe.id,
        kind,
        tile,
        x: tileX(tile, terrain.size) + 0.5,
        z: tileZ(tile, terrain.size) + 0.5,
        progress: 0.1, // 10% foundation
        maxProgress: spec.buildTicks,
        health: spec.maxHealth,
        maxHealth: spec.maxHealth,
        isComplete: false,
      };
      buildings.push(b);
      tribe.buildings.push(b);
      return b;
    },

    deliverMaterial(building, woodAmount, stoneAmount, tribe) {
      if (building.isComplete) return;

      building.progress += woodAmount * 2 + stoneAmount * 3;
      if (building.progress >= building.maxProgress) {
        building.progress = building.maxProgress;
        building.isComplete = true;

        // Apply completion benefits
        if (building.kind === BUILDING_KIND.HUT) {
          tribe.huts.push(building);
        } else if (building.kind === BUILDING_KIND.WAR_TOTEM) {
          tribe.warriors = Math.min(tribe.population, tribe.warriors + 2);
        }
      }
    },

    step(tribes) {
      // Slow passive maintenance/repair for complete buildings
      for (const b of buildings) {
        if (b.isComplete && b.health < b.maxHealth) {
          b.health = Math.min(b.maxHealth, b.health + 0.05);
        }
      }
    },

    toTelemetry() {
      return buildings.map(b => ({
        id: b.id,
        tribeId: b.tribeId,
        kind: b.kind,
        x: b.x,
        z: b.z,
        progress: b.progress / b.maxProgress,
        health: b.health / b.maxHealth,
        isComplete: b.isComplete,
      }));
    },
  };
}
