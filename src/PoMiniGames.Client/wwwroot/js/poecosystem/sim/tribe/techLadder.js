// techLadder.js — 4-tier tribal technological progression.
'use strict';

import { TECH_SPECS, TECH_TIER } from './contracts.js';
import { TRIBES } from '../core/config.js';

export function createTechLadder() {
  return {
    step(tribe, elderCount = 1) {
      // If already at maximum tier, no further research needed
      if (tribe.tech >= TECH_TIER.FORTIFICATION) return null;

      // Accumulate research points
      const rate = TRIBES.researchBasePerTick + elderCount * TRIBES.researchPerElderPerTick;
      tribe.researchPoints += rate;

      const nextTier = tribe.tech + 1;
      const spec = TECH_SPECS[nextTier];
      if (!spec) return null;

      // Check if research point and resource requirements are met
      const hasPoints = tribe.researchPoints >= spec.researchCost;
      const hasWood = tribe.wood >= (spec.woodCost || 0);
      const hasStone = tribe.stone >= (spec.stoneCost || 0);

      if (hasPoints && hasWood && hasStone) {
        tribe.wood -= (spec.woodCost || 0);
        tribe.stone -= (spec.stoneCost || 0);
        tribe.tech = nextTier;

        return {
          kind: 'tech_unlocked',
          tribeId: tribe.id,
          tribeName: tribe.name,
          techTier: nextTier,
          techName: spec.name,
        };
      }

      return null;
    },

    getGatherMultiplier(tribe, resourceKind) {
      const spec = TECH_SPECS[tribe.tech] || TECH_SPECS[TECH_TIER.PRIMITIVE];
      if (resourceKind === 'wood') return spec.chopMultiplier;
      if (resourceKind === 'food' || resourceKind === 'berries') return spec.gatherMultiplier;
      if (resourceKind === 'stone') return spec.chopMultiplier; // Mining uses toolcraft multiplier
      return 1.0;
    },

    getCombatMultiplier(tribe) {
      const spec = TECH_SPECS[tribe.tech] || TECH_SPECS[TECH_TIER.PRIMITIVE];
      return spec.combatMultiplier || 1.0;
    },
  };
}
