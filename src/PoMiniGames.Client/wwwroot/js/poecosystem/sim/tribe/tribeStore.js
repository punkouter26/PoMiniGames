// tribeStore.js — multi-tribe registry, settlement anchors, and inventory state.
'use strict';

import { DEFAULT_TRIBES, TECH_TIER, TRIBE_DIPLOMACY } from './contracts.js';
import { TRIBES } from '../core/config.js';
import { TILE, isWater, tileIndex, tileX, tileZ } from '../terrain/tiles.js';
import { createTerritoryManager } from './territory.js';
import { createTechLadder } from './techLadder.js';
import { createConstructionManager } from './construction.js';
import { createDiplomacyManager } from './diplomacy.js';
import { BUILDING_KIND, BUILDING_SPECS } from './contracts.js';

export function createTribeStore(terrain, streams) {
  const { size, type } = terrain;
  const territory = createTerritoryManager(size);
  const techLadder = createTechLadder();
  const construction = createConstructionManager();
  const diplomacy = createDiplomacyManager();

  // Find candidate center settlement tiles across the island with separation
  const grassTiles = [];
  for (let i = 0; i < type.length; i++) {
    if (type[i] === TILE.GRASS) {
      const x = tileX(i, size);
      const z = tileZ(i, size);
      // Keep away from direct outer perimeter
      if (x > 20 && x < size - 20 && z > 20 && z < size - 20) {
        grassTiles.push(i);
      }
    }
  }

  const placedTribes = [];
  const minSepSq = TRIBES.minTribeSeparation ** 2;

  for (let tIdx = 0; tIdx < DEFAULT_TRIBES.length; tIdx++) {
    const def = DEFAULT_TRIBES[tIdx];
    let chosenTile = -1;

    // Search for grass tile with sufficient distance from already placed tribes
    const offset = Math.floor(streams.terrain.uniform() * Math.max(1, grassTiles.length));
    for (let i = 0; i < grassTiles.length; i++) {
      const candidate = grassTiles[(offset + i) % grassTiles.length];
      const cx = tileX(candidate, size);
      const cz = tileZ(candidate, size);

      let tooClose = false;
      for (const placed of placedTribes) {
        const dSq = (cx - placed.centerX) ** 2 + (cz - placed.centerZ) ** 2;
        if (dSq < minSepSq) {
          tooClose = true;
          break;
        }
      }

      if (!tooClose) {
        chosenTile = candidate;
        break;
      }
    }

    // Fallback if island geometry is constrained
    if (chosenTile === -1 && grassTiles.length > 0) {
      chosenTile = grassTiles[tIdx % grassTiles.length];
    }

    const cx = chosenTile !== -1 ? tileX(chosenTile, size) + 0.5 : size / 2;
    const cz = chosenTile !== -1 ? tileZ(chosenTile, size) + 0.5 : size / 2;

    const relations = new Array(DEFAULT_TRIBES.length).fill(TRIBE_DIPLOMACY.NEUTRAL);
    relations[tIdx] = TRIBE_DIPLOMACY.ALLIED; // Self-alliance

    placedTribes.push({
      id: def.id,
      name: def.name,
      bannerColor: def.bannerColor,
      accentColor: def.accentColor,
      motto: def.motto,
      tech: def.startingTech,
      researchPoints: 0,
      population: TRIBES.humansPerTribe,
      warriors: 1,
      wood: 40,
      stone: 15,
      food: 100,
      centerTile: chosenTile,
      centerX: cx,
      centerZ: cz,
      territoryRadius: TRIBES.territoryRadius,
      huts: [],
      buildings: [],
      relations,
      traits: def.traits,
      casualtyCount: 0,
      warCooldownTicks: 0,
    });
  }

  return {
    tribes: placedTribes,
    territory,
    techLadder,
    diplomacy,

    getTribe(id) {
      return placedTribes.find(t => t.id === id) || null;
    },

    getTribeAt(x, z) {
      return territory.getDominantTribe(x, z, placedTribes);
    },

    stepDiplomacy(log = null) {
      return diplomacy.step(placedTribes, territory, log);
    },

    stepTech(log = null) {
      for (const tribe of placedTribes) {
        const event = techLadder.step(tribe, 1);
        if (event && log) {
          log.push(`Year ${event.tribeName} advanced to ${event.techName}`);
        }
      }
    },

    addResource(tribeId, resourceKind, amount) {
      const tribe = this.getTribe(tribeId);
      if (!tribe) return;
      if (resourceKind === 'wood') tribe.wood += amount;
      else if (resourceKind === 'stone') tribe.stone += amount;
      else if (resourceKind === 'food') tribe.food += amount;
    },

    consumeResource(tribeId, resourceKind, amount) {
      const tribe = this.getTribe(tribeId);
      if (!tribe) return false;
      if (resourceKind === 'wood' && tribe.wood >= amount) { tribe.wood -= amount; return true; }
      if (resourceKind === 'stone' && tribe.stone >= amount) { tribe.stone -= amount; return true; }
      if (resourceKind === 'food' && tribe.food >= amount) { tribe.food -= amount; return true; }
      return false;
    },

    stepConstruction(terrain, tileState, rng, log = null) {
      construction.step(placedTribes);

      // Every 5 seconds (100 ticks), evaluate whether to start new construction
      for (const tribe of placedTribes) {
        // Need hut if population > bed capacity
        const totalBeds = tribe.huts.length * 4;
        let neededKind = null;

        if (tribe.population > totalBeds) {
          neededKind = BUILDING_KIND.HUT;
        } else if (tribe.wood >= 60 && tribe.stone >= 35 && tribe.buildings.filter(b => b.kind === BUILDING_KIND.WATCHTOWER).length === 0) {
          neededKind = BUILDING_KIND.WATCHTOWER;
        } else if (tribe.wood >= 50 && tribe.stone >= 20 && tribe.buildings.filter(b => b.kind === BUILDING_KIND.GRANARY).length === 0) {
          neededKind = BUILDING_KIND.GRANARY;
        }

        if (neededKind !== null) {
          const spec = BUILDING_SPECS[neededKind];
          if (tribe.wood >= spec.cost.wood && tribe.stone >= spec.cost.stone) {
            const site = construction.findBuildSite(terrain, tileState, tribe, neededKind, rng);
            if (site !== null) {
              tribe.wood -= spec.cost.wood;
              tribe.stone -= spec.cost.stone;
              const building = construction.createBuilding(tribe, neededKind, site, terrain);
              if (log) {
                log.push(`${tribe.name} began raising a ${spec.name}`);
              }
            }
          }
        }

        // Progress incomplete buildings
        for (const b of tribe.buildings) {
          if (!b.isComplete) {
            construction.deliverMaterial(b, 0.5, 0.25, tribe);
          }
        }
      }
    },

    toTelemetry() {
      return placedTribes.map(t => ({
        id: t.id,
        name: t.name,
        bannerColor: t.bannerColor,
        tech: t.tech,
        population: t.population,
        warriors: t.warriors,
        wood: Math.round(t.wood),
        stone: Math.round(t.stone),
        food: Math.round(t.food),
        centerX: t.centerX,
        centerZ: t.centerZ,
        territoryRadius: t.territoryRadius,
        relations: [...t.relations],
      }));
    },

    getBuildingsTelemetry() {
      return construction.toTelemetry();
    },
  };
}
