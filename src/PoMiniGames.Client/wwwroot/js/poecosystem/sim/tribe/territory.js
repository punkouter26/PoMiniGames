// territory.js — territorial influence zones, border friction & resource claims.
'use strict';

import { tileX, tileZ } from '../terrain/tiles.js';

export function createTerritoryManager(worldSize) {
  const resourceClaims = new Map(); // tileIndex -> tribeId

  return {
    resourceClaims,

    getDominantTribe(x, z, tribes) {
      let closest = null;
      let minD = Infinity;

      for (const tribe of tribes) {
        const d = Math.hypot(x - tribe.centerX, z - tribe.centerZ);
        if (d <= tribe.territoryRadius && d < minD) {
          minD = d;
          closest = tribe;
        }
      }
      return closest;
    },

    isTileClaimedBy(tile, tribeId) {
      return resourceClaims.get(tile) === tribeId;
    },

    claimTile(tile, tribeId) {
      resourceClaims.set(tile, tribeId);
    },

    releaseTile(tile) {
      resourceClaims.delete(tile);
    },

    computeBorderFriction(tribeA, tribeB) {
      const d = Math.hypot(tribeA.centerX - tribeB.centerX, tribeA.centerZ - tribeB.centerZ);
      const combinedRadius = tribeA.territoryRadius + tribeB.territoryRadius;
      if (d >= combinedRadius) return 0;
      // Overlap ratio: 0.0 (just touching) to 1.0 (fully overlapping)
      return Math.min(1.0, (combinedRadius - d) / Math.max(1, combinedRadius));
    },

    getTerritoryContours(tribes) {
      return tribes.map(t => ({
        tribeId: t.id,
        centerX: t.centerX,
        centerZ: t.centerZ,
        radius: t.territoryRadius,
        bannerColor: t.bannerColor,
      }));
    },
  };
}
