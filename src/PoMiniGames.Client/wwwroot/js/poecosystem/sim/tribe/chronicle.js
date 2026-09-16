// chronicle.js — procedural milestone generation and narrative chronicle feed.
'use strict';

export function createTribeChronicle() {
  const milestones = [];

  return {
    milestones,

    record(year, day, text, kind, tribeId = null) {
      const entry = {
        id: milestones.length + 1,
        year,
        day,
        timestamp: `Year ${year}, Day ${day}`,
        text,
        kind,
        tribeId,
      };
      milestones.push(entry);
      if (milestones.length > 250) {
        milestones.shift();
      }
      return entry;
    },

    getRecent(limit = 20) {
      return milestones.slice(-limit).reverse();
    },
  };
}
