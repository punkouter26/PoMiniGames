// combat.js — skirmish combat calculations and casualty resolution between tribes.
'use strict';

import { TRIBE_DIPLOMACY } from '../tribe/contracts.js';

export function resolveSkirmish(warriorA, tribeA, warriorB, tribeB, techLadder) {
  // Only fight if tribes are at war
  if (tribeA.relations[tribeB.id] !== TRIBE_DIPLOMACY.WAR) return null;

  const multA = techLadder.getCombatMultiplier(tribeA);
  const multB = techLadder.getCombatMultiplier(tribeB);

  const damageA = (15 + Math.random() * 10) * multA;
  const damageB = (15 + Math.random() * 10) * multB;

  return {
    damageToA: damageB,
    damageToB: damageA,
    fatalToA: damageB >= 40,
    fatalToB: damageA >= 40,
  };
}

export function registerCasualty(tribe) {
  tribe.casualtyCount++;
  tribe.population = Math.max(1, tribe.population - 1);
}
