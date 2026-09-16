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

/** Check if decade pre-warming should trigger at Year 9.8 of each decade. */
export function shouldPrewarmDecade(year, tick, ticksPerYear = 100) {
  const decadeYear = year % 10;
  return decadeYear === 9 && (tick % ticksPerYear) >= (ticksPerYear * 0.8);
}

/** Client-side log summary compressor to filter out mundane ticks. */
export function compressLogSummary(events) {
  if (!events || events.length === 0) return 'The island remained quiet.';
  const notable = events
    .filter(e => {
      const txt = (typeof e === 'string' ? e : (e?.text || '')).toLowerCase();
      return !txt.includes('ate') && !txt.includes('drank') && !txt.includes('graz') && !txt.includes('forag');
    })
    .slice(-25);
  return notable.map(e => (typeof e === 'string' ? e : e?.text || '')).join('; ');
}

