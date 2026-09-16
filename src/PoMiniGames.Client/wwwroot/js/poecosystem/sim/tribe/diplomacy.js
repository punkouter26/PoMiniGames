// diplomacy.js — inter-tribe relations state machine & war triggers.
'use strict';

import { TRIBE_DIPLOMACY } from './contracts.js';
import { TRIBES } from '../core/config.js';

export function createDiplomacyManager() {
  return {
    step(tribes, territory, log = null) {
      const events = [];

      for (let i = 0; i < tribes.length; i++) {
        const tribeA = tribes[i];
        if (tribeA.warCooldownTicks > 0) {
          tribeA.warCooldownTicks--;
        }

        for (let j = i + 1; j < tribes.length; j++) {
          const tribeB = tribes[j];
          const currentRelation = tribeA.relations[tribeB.id];
          const friction = territory.computeBorderFriction(tribeA, tribeB);

          // 1. If at WAR: check casualty/peace thresholds
          if (currentRelation === TRIBE_DIPLOMACY.WAR) {
            const highCasualtiesA = tribeA.casualtyCount >= Math.max(1, tribeA.population * TRIBES.warCasualtyThreshold);
            const highCasualtiesB = tribeB.casualtyCount >= Math.max(1, tribeB.population * TRIBES.warCasualtyThreshold);

            if (highCasualtiesA || highCasualtiesB || (tribeA.warCooldownTicks === 0 && Math.random() < 0.005)) {
              // Conclude peace treaty
              tribeA.relations[tribeB.id] = TRIBE_DIPLOMACY.NEUTRAL;
              tribeB.relations[tribeA.id] = TRIBE_DIPLOMACY.NEUTRAL;
              tribeA.warCooldownTicks = TRIBES.peaceCooldownTicks;
              tribeB.warCooldownTicks = TRIBES.peaceCooldownTicks;
              tribeA.casualtyCount = 0;
              tribeB.casualtyCount = 0;

              const event = {
                kind: 'peace_treaty',
                tribeAId: tribeA.id,
                tribeAName: tribeA.name,
                tribeBId: tribeB.id,
                tribeBName: tribeB.name,
                text: `${tribeA.name} and ${tribeB.name} forged a lasting peace treaty`,
              };
              events.push(event);
              if (log) log.push(event.text);
            }
          }
          // 2. If NEUTRAL or RIVAL: check if war triggers
          else if (currentRelation !== TRIBE_DIPLOMACY.ALLIED && tribeA.warCooldownTicks === 0 && tribeB.warCooldownTicks === 0) {
            // Friction and scarcity increase tension
            const scarcityA = tribeA.food < 30 || tribeA.wood < 20;
            const tension = friction * TRIBES.frictionBorderOverlapWeight + (scarcityA ? 0.3 : 0);

            if (tension > 0.45 && currentRelation !== TRIBE_DIPLOMACY.RIVAL) {
              tribeA.relations[tribeB.id] = TRIBE_DIPLOMACY.RIVAL;
              tribeB.relations[tribeA.id] = TRIBE_DIPLOMACY.RIVAL;
            } else if (tension > 0.75) {
              // Outbreak of war
              tribeA.relations[tribeB.id] = TRIBE_DIPLOMACY.WAR;
              tribeB.relations[tribeA.id] = TRIBE_DIPLOMACY.WAR;
              tribeA.warCooldownTicks = 800; // Minimum war engagement window
              tribeB.warCooldownTicks = 800;

              const event = {
                kind: 'war_declared',
                tribeAId: tribeA.id,
                tribeAName: tribeA.name,
                tribeBId: tribeB.id,
                tribeBName: tribeB.name,
                text: `${tribeA.name} declared war on ${tribeB.name} over disputed borders`,
              };
              events.push(event);
              if (log) log.push(event.text);
            }
          }
        }
      }

      return events;
    },
  };
}
